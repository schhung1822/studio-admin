"use client";

import type { TranscribeResponse } from "../api/transcribe/route";
import {
  FFmpegExecError,
  execFFmpeg,
  getFFmpeg,
  parseDurationLog,
  takeOutputFile,
  withInputFile,
} from "./ffmpeg";

export type { TranscribeResponse, TranscriptSegment, TranscriptWord } from "../api/transcribe/route";

/** Groq accepts up to 25 MB; at the bitrate below that is far more than 20 minutes. */
export const MAX_SPEECH_SECONDS = 20 * 60;
// Mono 16 kHz at 24 kbps is plenty for speech and keeps a 20-minute clip around 3.6 MB,
// under both Groq's 25 MB limit and typical serverless body limits (e.g. 4.5 MB on Vercel).
const AUDIO_BITRATE = "24k";
const OUTPUT_FILE = "/speech-audio.mp3";

export const SPEECH_LANGUAGE_OPTIONS = [
  { label: "Tiếng Anh (English)", value: "en" },
  { label: "Dịch sang tiếng Anh (từ ngôn ngữ bất kỳ)", value: "translate-en" },
  { label: "Tiếng Việt", value: "vi" },
  { label: "Tiếng Đức (Deutsch)", value: "de" },
  { label: "Tiếng Nhật (日本語)", value: "ja" },
  { label: "Tiếng Hàn (한국어)", value: "ko" },
  { label: "Tiếng Trung (中文)", value: "zh" },
];

export function speechLanguageHelpText(language: string) {
  return language === "translate-en"
    ? "Giọng nói ở bất kỳ ngôn ngữ nào sẽ được dịch sang tiếng Anh. Chế độ dịch không có mốc thời gian từng từ nên việc chia cảnh chỉ là ước lượng."
    : "Chọn đúng ngôn ngữ đang được nói trong video. Muốn đổi sang tiếng Anh, chọn “Dịch sang tiếng Anh”.";
}

/** Extracts a small mono MP3 of the first 20 minutes of speech from a video, in the browser. */
export async function extractSpeechAudio(
  file: File,
  {
    durationHint,
    onStage,
    onProgress,
  }: { durationHint?: number | null; onStage?: (message: string) => void; onProgress?: (percent: number) => void } = {},
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(onStage);

  // Fall back to FFmpeg's own report if the browser could not read the duration.
  let duration = durationHint ?? null;
  onStage?.("Đang tách âm thanh…");
  onProgress?.(0);

  return withInputFile(ffmpeg, file, async (inputPath) => {
    try {
      await execFFmpeg(
        ffmpeg,
        [
          "-i", inputPath,
          "-vn",
          "-ac", "1",
          "-ar", "16000",
          "-c:a", "libmp3lame",
          "-b:a", AUDIO_BITRATE,
          "-t", String(MAX_SPEECH_SECONDS),
          "-y", OUTPUT_FILE,
        ],
        {
          onLog: (message) => {
            duration ??= parseDurationLog(message);
          },
          onTime: (seconds) => {
            if (duration) onProgress?.(Math.min(100, Math.max(0, (seconds / duration) * 100)));
          },
        },
      );
    } catch (error) {
      const noAudio =
        error instanceof FFmpegExecError &&
        error.logs.some((line) => /does not contain any stream|matches no streams|no audio/i.test(line));
      throw noAudio ? new Error("Video này không có track âm thanh.") : error;
    }
    const audio = await takeOutputFile(ffmpeg, OUTPUT_FILE, "audio/mpeg");
    onProgress?.(100);
    return audio;
  });
}

/** Sends extracted audio to our /api/transcribe route (Groq Whisper). */
export async function requestTranscription(
  audio: Blob,
  language: string,
  signal?: AbortSignal,
): Promise<TranscribeResponse> {
  const body = new FormData();
  body.append("file", audio, "audio.mp3");
  body.append("language", language);

  const response = await fetch("/api/transcribe", { method: "POST", body, signal });
  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Non-JSON body (e.g. a proxy or platform error page).
  }
  if (!response.ok) {
    const apiError = (parsed as { error?: string } | null)?.error;
    throw new Error(apiError ?? `Nhận dạng thất bại (HTTP ${response.status}).`);
  }
  if (!parsed) throw new Error("Máy chủ trả về dữ liệu không đọc được.");
  return parsed as TranscribeResponse;
}
