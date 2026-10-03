import { readFile } from "node:fs/promises";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
// A 20-minute file usually transcribes in well under a minute on Groq, but leave headroom.
export const maxDuration = 120;

const GROQ_BASE_URL = "https://api.groq.com/openai/v1/audio";
const WHISPER_MODEL = "whisper-large-v3";

// Groq rejects direct uploads above 25 MB.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// ISO-639-1 codes accepted from the client.
// "translate-en" = Whisper's translate task: speech in any language -> English text.
const TRANSLATE_TO_ENGLISH = "translate-en";
const SUPPORTED_LANGUAGES = new Set(["en", "vi", "de", "ja", "ko", "zh", TRANSLATE_TO_ENGLISH]);

interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface WhisperVerboseResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: WhisperSegment[];
  words?: { word: string; start: number; end: number }[];
}

/** One subtitle cue, times in seconds. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export interface TranscribeResponse {
  text: string;
  srt: string;
  segments: TranscriptSegment[];
  /** Word-level timings; null when unavailable (Whisper's translate mode has none). */
  words: TranscriptWord[] | null;
  language: string;
  detectedLanguage: string | null;
  duration: number | null;
  mode: "transcription" | "translation";
}

/**
 * The web deployment uses the GROQ_API_KEY environment variable. The Windows app instead
 * points STUDIO_SETTINGS_FILE at the user's settings, read per request so a newly saved
 * key works without restarting.
 */
async function resolveApiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const settingsFile = process.env.STUDIO_SETTINGS_FILE;
  if (!settingsFile) return null;
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as { groqApiKey?: unknown };
    return typeof settings.groqApiKey === "string" && settings.groqApiKey.trim() ? settings.groqApiKey.trim() : null;
  } catch {
    return null;
  }
}

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function formatSrtTimestamp(totalSeconds: number): string {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, width = 2) => n.toString().padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

function segmentsToSrt(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}\n${segment.text}\n`,
    )
    .join("\n");
}

export async function POST(request: NextRequest) {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return errorResponse(
      process.env.STUDIO_SETTINGS_FILE
        ? "Chưa nhập Groq API key. Vào mục Cài đặt để nhập key."
        : "Máy chủ chưa cấu hình GROQ_API_KEY. Thêm vào .env.local rồi khởi động lại.",
      500,
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("Dữ liệu gửi lên phải là multipart/form-data.", 400);
  }

  const file = formData.get("file");
  const language = formData.get("language");

  if (!(file instanceof File) || file.size === 0) {
    return errorResponse("Chưa có file âm thanh được gửi lên.", 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return errorResponse(
      `File âm thanh nặng ${(file.size / 1024 / 1024).toFixed(1)} MB, vượt giới hạn 25 MB.`,
      413,
    );
  }
  if (typeof language !== "string" || !SUPPORTED_LANGUAGES.has(language)) {
    return errorResponse("Ngôn ngữ đầu ra không được hỗ trợ.", 400);
  }

  // Whisper can only *translate* into English. For every other language we transcribe
  // and pass the language as a hint, which assumes the audio is spoken in that language.
  const mode: TranscribeResponse["mode"] = language === TRANSLATE_TO_ENGLISH ? "translation" : "transcription";

  const groqForm = new FormData();
  groqForm.append("file", file, file.name || "audio.mp3");
  groqForm.append("model", WHISPER_MODEL);
  groqForm.append("response_format", "verbose_json");
  groqForm.append("temperature", "0");
  if (mode === "transcription") {
    groqForm.append("language", language);
    groqForm.append("timestamp_granularities[]", "segment");
    groqForm.append("timestamp_granularities[]", "word");
  }

  let groqResponse: Response;
  try {
    groqResponse = await fetch(`${GROQ_BASE_URL}/${mode === "translation" ? "translations" : "transcriptions"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: groqForm,
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse("Yêu cầu đã bị hủy.", 499);
    }
    console.error("[transcribe] Network error calling Groq:", error);
    return errorResponse("Không kết nối được Groq API. Vui lòng thử lại.", 502);
  }

  if (!groqResponse.ok) {
    let detail = groqResponse.statusText;
    try {
      const body = (await groqResponse.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? detail;
    } catch {
      // Non-JSON error body; keep the status text.
    }
    console.error(`[transcribe] Groq returned ${groqResponse.status}: ${detail}`);
    const status = groqResponse.status === 429 ? 429 : 502;
    return errorResponse(`Lỗi Groq API (${groqResponse.status}): ${detail}`, status);
  }

  let result: WhisperVerboseResponse;
  try {
    result = (await groqResponse.json()) as WhisperVerboseResponse;
  } catch {
    return errorResponse("Groq trả về dữ liệu không đọc được.", 502);
  }

  const text = (result.text ?? "").trim();
  let segments: TranscriptSegment[] = (result.segments ?? [])
    .map(({ start, end, text: segmentText }) => ({ start, end, text: segmentText.trim() }))
    .filter((segment) => segment.text.length > 0);
  if (segments.length === 0 && text) {
    segments = [{ start: 0, end: result.duration ?? 0, text }];
  }
  const srt = segmentsToSrt(segments);

  const payload: TranscribeResponse = {
    text,
    srt,
    segments,
    words: result.words
      ? result.words.map(({ word, start, end }) => ({ text: word.trim(), start, end })).filter((word) => word.text)
      : null,
    language,
    detectedLanguage: result.language ?? null,
    duration: result.duration ?? null,
    mode,
  };
  return Response.json(payload);
}
