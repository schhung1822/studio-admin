"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DropZone,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { downloadBlob, formatBytes, formatTimecode } from "../_lib/format";
import { describeError, isTerminationError, terminateFFmpeg } from "../_lib/ffmpeg";
import {
  MAX_SPEECH_SECONDS as MAX_DURATION_SECONDS,
  SPEECH_LANGUAGE_OPTIONS as LANGUAGE_OPTIONS,
  extractSpeechAudio,
  requestTranscription,
  speechLanguageHelpText,
  type TranscribeResponse,
} from "../_lib/speech";

const FORMAT_OPTIONS = [
  { label: "Phụ đề SubRip (.srt)", value: "srt" },
  { label: "Văn bản thuần (.txt)", value: "text" },
  { label: "Lời bài hát LRC (.txt)", value: "lrc" },
];

type Status = "idle" | "extracting" | "transcribing" | "completed" | "error";
type OutputFormat = "srt" | "text" | "lrc";

const EMPTY_OUTPUTS: Record<OutputFormat, string> = { srt: "", text: "", lrc: "" };

// A silence at least this long after a line (e.g. an instrumental break) gets an empty
// timestamp line, so karaoke players clear the previous lyric instead of leaving it up.
const LRC_BREAK_SECONDS = 4;

/** 83.456 -> "01:23.46" (minutes keep counting past 59, as LRC players expect). */
function formatLrcTimestamp(seconds: number) {
  const centis = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(centis / 6000);
  const secs = Math.floor((centis % 6000) / 100);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `[${pad(minutes)}:${pad(secs)}.${pad(centis % 100)}]`;
}

/** One "[mm:ss.xx]lyric" line per segment, plus an empty line at long breaks and at the end. */
function segmentsToLrc(segments: TranscribeResponse["segments"]) {
  const lines = segments
    .map((segment) => ({ ...segment, text: segment.text.replace(/\s+/g, " ").trim() }))
    .filter((segment) => segment.text);
  return lines
    .flatMap((segment, index) => {
      const next = lines[index + 1];
      const out = [`${formatLrcTimestamp(segment.start)}${segment.text}`];
      if (!next || next.start - segment.end >= LRC_BREAK_SECONDS) out.push(formatLrcTimestamp(segment.end));
      return out;
    })
    .join("\n");
}

const STATUS_META: Record<Status, { label: string; tone?: "info" | "attention" | "success" | "critical" }> = {
  idle: { label: "Sẵn sàng" },
  extracting: { label: "Đang tách âm thanh (FFmpeg)", tone: "attention" },
  transcribing: { label: "Đang nhận dạng giọng nói (Groq)", tone: "info" },
  completed: { label: "Hoàn tất", tone: "success" },
  error: { label: "Lỗi", tone: "critical" },
};

function isMp4(file: File) {
  return file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4");
}

export default function SubtitlesPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [language, setLanguage] = useState("en");
  const [format, setFormat] = useState<OutputFormat>("srt");
  const [status, setStatus] = useState<Status>("idle");
  const [stageDetail, setStageDetail] = useState("");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<OutputFormat, string>>(EMPTY_OUTPUTS);
  const [resultMeta, setResultMeta] = useState<TranscribeResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  const busy = status === "extracting" || status === "transcribing";
  const tooLong = videoDuration !== null && videoDuration > MAX_DURATION_SECONDS;

  // Release the preview blob URL whenever it is replaced or the page unmounts.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // On unmount, cancel in-flight work. The shared FFmpeg worker is only killed if it is
  // busy for us; otherwise it stays loaded for the next tool.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (busyRef.current) terminateFFmpeg();
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const resetResult = useCallback(() => {
    setStatus("idle");
    setStageDetail("");
    setProgress(0);
    setErrorMessage(null);
    setOutputs(EMPTY_OUTPUTS);
    setResultMeta(null);
  }, []);

  const handleDrop = useCallback(
    (_all: File[], accepted: File[], rejected: File[]) => {
      const next = accepted[0] ?? rejected[0];
      if (!next) return;
      resetResult();
      if (!isMp4(next)) {
        setFile(null);
        setPreviewUrl(null);
        setVideoDuration(null);
        setStatus("error");
        setErrorMessage(`"${next.name}" không phải video MP4.`);
        return;
      }
      setFile(next);
      setVideoDuration(null);
      setPreviewUrl(URL.createObjectURL(next));
    },
    [resetResult],
  );

  const clearFile = useCallback(() => {
    setFile(null);
    setPreviewUrl(null);
    setVideoDuration(null);
    resetResult();
  }, [resetResult]);

  const extractAudio = useCallback(
    (input: File) =>
      extractSpeechAudio(input, { durationHint: videoDuration, onStage: setStageDetail, onProgress: setProgress }),
    [videoDuration],
  );

  const transcribe = useCallback(async (audio: Blob, lang: string): Promise<TranscribeResponse> => {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      return await requestTranscription(audio, lang, controller.signal);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const handleProcess = useCallback(async () => {
    if (!file || busyRef.current || tooLong) return;

    resetResult();
    busyRef.current = true;
    setStatus("extracting");
    try {
      const audio = await extractAudio(file);
      if (!mountedRef.current) return;

      setStatus("transcribing");
      setStageDetail(`Đang gửi ${formatBytes(audio.size)} âm thanh tới Groq Whisper…`);
      const result = await transcribe(audio, language);
      if (!mountedRef.current) return;

      if (!result.text) throw new Error("Không phát hiện giọng nói trong video.");
      setOutputs({ srt: result.srt, text: result.text, lrc: segmentsToLrc(result.segments) });
      setResultMeta(result);
      setStageDetail("");
      setStatus("completed");
    } catch (error) {
      if (!mountedRef.current || isTerminationError(error)) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("[subtitles]", error);
      setStatus("error");
      setStageDetail("");
      setErrorMessage(describeError(error));
    } finally {
      busyRef.current = false;
    }
  }, [extractAudio, file, language, resetResult, tooLong, transcribe]);

  const currentOutput = outputs[format];

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentOutput);
      setCopied(true);
    } catch {
      setErrorMessage("Không truy cập được clipboard. Hãy bôi đen và sao chép thủ công.");
    }
  }, [currentOutput]);

  const handleDownload = useCallback(() => {
    const baseName = file?.name.replace(/\.[^.]+$/, "") || "subtitles";
    const extension = format === "srt" ? "srt" : format === "lrc" ? "lyrics.txt" : "txt";
    downloadBlob(
      new Blob([currentOutput], { type: "text/plain;charset=utf-8" }),
      `${baseName}.${language === "translate-en" ? "en" : language}.${extension}`,
    );
  }, [currentOutput, file, format, language]);

  const statusMeta = STATUS_META[status];

  return (
    <Page
      fullWidth
      backAction={{ content: "Tổng quan", url: "/" }}
      title="Tách phụ đề"
      subtitle="Tách âm thanh ngay trên trình duyệt bằng FFmpeg, sau đó nhận dạng giọng nói bằng Groq Whisper."
      primaryAction={{
        content: "Xử lý",
        onAction: handleProcess,
        disabled: !file || tooLong || busy,
        loading: busy,
      }}
      secondaryActions={file ? [{ content: "Gỡ video", destructive: true, onAction: clearFile, disabled: busy }] : undefined}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Video
                </Text>
                <DropZone
                  accept="video/mp4"
                  type="file"
                  allowMultiple={false}
                  disabled={busy}
                  onDrop={handleDrop}
                  label="Video MP4, tối đa 20 phút"
                  labelHidden
                >
                  {file ? (
                    <div style={{ padding: "var(--p-space-400)" }}>
                      <BlockStack gap="100" inlineAlign="center">
                        <Text as="p" variant="bodyMd" fontWeight="semibold" breakWord>
                          {file.name}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {formatBytes(file.size)}
                          {videoDuration !== null && ` · ${formatTimecode(videoDuration, { fractional: false })}`}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Kéo thả hoặc bấm để chọn video khác
                        </Text>
                      </BlockStack>
                    </div>
                  ) : (
                    <DropZone.FileUpload actionTitle="Chọn video" actionHint="Chấp nhận .mp4, tối đa 20 phút" />
                  )}
                </DropZone>

                {previewUrl && (
                  <video
                    src={previewUrl}
                    controls
                    preload="metadata"
                    style={{ width: "100%", maxHeight: 360, borderRadius: "var(--p-border-radius-200)", background: "#000" }}
                    onLoadedMetadata={(event) => {
                      const seconds = event.currentTarget.duration;
                      if (Number.isFinite(seconds)) setVideoDuration(seconds);
                    }}
                  />
                )}

                {tooLong && videoDuration !== null && (
                  <Banner tone="critical" title="Video quá dài">
                    <p>
                      Video dài {formatTimecode(videoDuration, { fractional: false })}, tối đa cho phép là{" "}
                      {formatTimecode(MAX_DURATION_SECONDS)}. Hãy dùng công cụ Cắt video để chia nhỏ trước.
                    </p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Phụ đề
                  </Text>
                  {resultMeta?.detectedLanguage && <Badge>{`Ngôn ngữ nhận diện: ${resultMeta.detectedLanguage}`}</Badge>}
                </InlineStack>
                <TextField
                  label="Kết quả"
                  labelHidden
                  value={currentOutput}
                  onChange={(value) => setOutputs((prev) => ({ ...prev, [format]: value }))}
                  multiline={14}
                  maxHeight={480}
                  monospaced
                  autoComplete="off"
                  disabled={status !== "completed"}
                  placeholder="Phụ đề sẽ hiển thị ở đây sau khi xử lý xong. Bạn có thể chỉnh sửa trực tiếp."
                />
                <InlineStack gap="200" align="end">
                  <Button onClick={handleCopy} disabled={!currentOutput}>
                    {copied ? "Đã sao chép!" : "Sao chép"}
                  </Button>
                  <Button onClick={handleDownload} disabled={!currentOutput}>
                    {`Tải .${format === "srt" ? "srt" : "txt"}`}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Cài đặt
                </Text>
                <Select
                  label="Ngôn ngữ đầu ra"
                  options={LANGUAGE_OPTIONS}
                  value={language}
                  onChange={setLanguage}
                  disabled={busy}
                  helpText={speechLanguageHelpText(language)}
                />
                <Select
                  label="Định dạng"
                  options={FORMAT_OPTIONS}
                  value={format}
                  onChange={(value) => setFormat(value as OutputFormat)}
                  helpText={
                    format === "lrc"
                      ? "Mỗi câu một dòng dạng [phút:giây.xx]lời, dùng cho trình phát nhạc/karaoke. Xuất ra file .txt."
                      : undefined
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Trạng thái
                  </Text>
                  <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                </InlineStack>

                {status === "extracting" && (
                  <BlockStack gap="200">
                    <ProgressBar progress={progress} size="small" tone="primary" />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {stageDetail} {progress > 0 && `${Math.round(progress)}%`}
                    </Text>
                  </BlockStack>
                )}

                {status === "transcribing" && (
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <Spinner size="small" accessibilityLabel="Đang nhận dạng" />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {stageDetail}
                    </Text>
                  </InlineStack>
                )}

                {status === "idle" && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {file ? "Sẵn sàng. Bấm Xử lý để bắt đầu." : "Tải lên một video MP4 để bắt đầu."}
                  </Text>
                )}

                {status === "completed" && resultMeta && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {resultMeta.mode === "translation" ? "Đã dịch sang tiếng Anh" : "Đã nhận dạng"}
                    {resultMeta.duration ? ` · ${formatTimecode(resultMeta.duration, { fractional: false })} âm thanh` : ""}
                  </Text>
                )}

                {errorMessage && (
                  <Banner tone="critical" title="Lỗi" onDismiss={() => setErrorMessage(null)}>
                    <p>{errorMessage}</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
