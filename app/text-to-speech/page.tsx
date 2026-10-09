"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  RangeSlider,
  Select,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { PauseCircleIcon, PlayIcon } from "@shopify/polaris-icons";
import { downloadBlob, formatBytes, formatTimecode, normalizeSearch } from "../_lib/format";
import { describeError, execFFmpeg, getFFmpeg, takeOutputFile, withInputFile } from "../_lib/ffmpeg";
import {
  MODEL_DOWNLOAD_BYTES,
  TtsCancelledError,
  VOICES,
  clearModelCache,
  getTtsEngine,
  isModelDownloaded,
  loadedTtsBackend,
  terminateTts,
  type TtsBackend,
  type TtsLoadStatus,
  type VoiceId,
} from "../_lib/tts/client";
import { encodeWav, type SupertonicLang } from "../_lib/tts/supertonic";

const TEXT_FIELD_ID = "tts-text";
const MAX_CHARS = 10_000;
const DEFAULT_TEXT =
  "Xin chào! Đây là giọng nói được tạo hoàn toàn trên máy của bạn, không cần gửi dữ liệu lên máy chủ.";

const LANGUAGE_OPTIONS: { label: string; value: SupertonicLang }[] = [
  { label: "Tiếng Việt", value: "vi" },
  { label: "Tiếng Anh", value: "en" },
  { label: "Tự nhận diện (đa ngôn ngữ)", value: "na" },
  { label: "Tiếng Ả Rập", value: "ar" },
  { label: "Tiếng Ba Lan", value: "pl" },
  { label: "Tiếng Bồ Đào Nha", value: "pt" },
  { label: "Tiếng Bulgaria", value: "bg" },
  { label: "Tiếng Croatia", value: "hr" },
  { label: "Tiếng Đan Mạch", value: "da" },
  { label: "Tiếng Đức", value: "de" },
  { label: "Tiếng Estonia", value: "et" },
  { label: "Tiếng Hà Lan", value: "nl" },
  { label: "Tiếng Hàn", value: "ko" },
  { label: "Tiếng Hindi", value: "hi" },
  { label: "Tiếng Hungary", value: "hu" },
  { label: "Tiếng Hy Lạp", value: "el" },
  { label: "Tiếng Indonesia", value: "id" },
  { label: "Tiếng Latvia", value: "lv" },
  { label: "Tiếng Litva", value: "lt" },
  { label: "Tiếng Nga", value: "ru" },
  { label: "Tiếng Nhật", value: "ja" },
  { label: "Tiếng Phần Lan", value: "fi" },
  { label: "Tiếng Pháp", value: "fr" },
  { label: "Tiếng Romania", value: "ro" },
  { label: "Tiếng Séc", value: "cs" },
  { label: "Tiếng Slovakia", value: "sk" },
  { label: "Tiếng Slovenia", value: "sl" },
  { label: "Tiếng Tây Ban Nha", value: "es" },
  { label: "Tiếng Thổ Nhĩ Kỳ", value: "tr" },
  { label: "Tiếng Thụy Điển", value: "sv" },
  { label: "Tiếng Ukraina", value: "uk" },
  { label: "Tiếng Ý", value: "it" },
];

const BACKEND_OPTIONS: { label: string; value: TtsBackend }[] = [
  { label: "Tự động (GPU nếu có)", value: "auto" },
  { label: "CPU (WebAssembly)", value: "wasm" },
];

/** Inline expression tags understood by Supertonic 3. */
const EXPRESSION_TAGS = [
  { tag: "<laugh>", label: "Cười" },
  { tag: "<breath>", label: "Hít thở" },
  { tag: "<sigh>", label: "Thở dài" },
];

/** Read by the voice previews when the text box is empty. */
const PREVIEW_SAMPLES: Partial<Record<SupertonicLang, string>> = {
  vi: "Xin chào, đây là giọng đọc thử. Bạn thấy giọng này thế nào?",
  en: "Hello, this is a sample of my voice. How does it sound to you?",
  na: "Hello, this is a sample of my voice. How does it sound to you?",
};
const PREVIEW_MIN_CHARS = 40;
const PREVIEW_MAX_CHARS = 160;
/** Generated previews kept for instant replay. */
const PREVIEW_CACHE_SIZE = 40;

// Male and female voices side by side in the two-column picker.
const VOICE_GRID = VOICES.filter((v) => v.value.startsWith("M")).flatMap((male, i) => [
  male,
  VOICES.filter((v) => v.value.startsWith("F"))[i],
]);

type Phase = "idle" | "loading" | "synthesizing" | "error";

interface SpeechResult {
  id: number;
  url: string;
  wav: Blob;
  text: string;
  voice: VoiceId;
  lang: SupertonicLang;
  seconds: number;
  elapsedMs: number;
  backend: "webgpu" | "wasm";
  mp3Busy?: boolean;
}

function voiceLabel(voice: VoiceId) {
  return VOICES.find((item) => item.value === voice)?.label ?? voice;
}

/** "Xin chào, thế giới!" → "xin-chao-the-gioi" (for download names). */
function slugify(text: string) {
  const slug = normalizeSearch(text.replace(/<[^>]+>/g, " "))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "giong-noi";
}

/**
 * Opening of the user's text: whole sentences until it is long enough to judge a voice, shortened at a word
 * boundary. A stock sentence when the text is empty.
 */
function previewSentence(text: string, lang: SupertonicLang) {
  const sentences = text.trim().split(/(?<=[.!?…。！？])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  let first = "";
  for (const sentence of sentences) {
    if (first.length >= PREVIEW_MIN_CHARS) break;
    first = first ? `${first} ${sentence}` : sentence;
  }
  if (!first) return PREVIEW_SAMPLES[lang] ?? null;
  if (first.length <= PREVIEW_MAX_CHARS) return first;
  const cut = first.slice(0, PREVIEW_MAX_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : PREVIEW_MAX_CHARS)}…`;
}

function describeLoad(status: TtsLoadStatus | null) {
  if (!status) return "Đang chuẩn bị…";
  if (status.stage === "init") return status.message;
  return status.cached
    ? "Đang nạp mô hình từ bộ nhớ máy…"
    : `Đang tải mô hình: ${formatBytes(status.loaded)} / ${formatBytes(status.total)}`;
}

export default function TextToSpeechPage() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [lang, setLang] = useState<SupertonicLang>("vi");
  const [voice, setVoice] = useState<VoiceId>("F1");
  const [speed, setSpeed] = useState(1.05);
  const [steps, setSteps] = useState(8);
  const [silence, setSilence] = useState(0.3);
  const [backend, setBackend] = useState<TtsBackend>("auto");

  const [phase, setPhase] = useState<Phase>("idle");
  const [loadStatus, setLoadStatus] = useState<TtsLoadStatus | null>(null);
  const [progress, setProgress] = useState({ percent: 0, chunk: 0, chunks: 0 });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<boolean | null>(null);
  const [activeBackend, setActiveBackend] = useState(loadedTtsBackend);
  const [results, setResults] = useState<SpeechResult[]>([]);
  const [previewLoading, setPreviewLoading] = useState<VoiceId | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState<VoiceId | null>(null);

  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  /** Preview WAV URLs keyed by voice + sentence + settings, oldest first. */
  const previewCacheRef = useRef(new Map<string, string>());
  const mountedRef = useRef(true);
  const phaseRef = useRef<Phase>("idle");
  const resultsRef = useRef<SpeechResult[]>([]);
  const nextIdRef = useRef(1);

  const busy = phase === "loading" || phase === "synthesizing";
  const trimmed = text.trim();
  const sampleSentence = previewSentence(text, lang);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    mountedRef.current = true;
    void isModelDownloaded().then((value) => mountedRef.current && setDownloaded(value));
    return () => {
      mountedRef.current = false;
      // A download keeps going in the background (the next visit picks it up); a synthesis
      // nobody will hear is stopped.
      if (phaseRef.current === "synthesizing") terminateTts();
      for (const result of resultsRef.current) URL.revokeObjectURL(result.url);
    };
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.onended = () => setPreviewPlaying(null);
    audio.onpause = () => setPreviewPlaying(null);
    previewAudioRef.current = audio;
    const cache = previewCacheRef.current;
    return () => {
      audio.pause();
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, []);

  const updateResult = useCallback((id: number, patch: Partial<SpeechResult>) => {
    setResults((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const loadEngine = useCallback(async () => {
    setPhase("loading");
    setLoadStatus(null);
    const engine = await getTtsEngine(backend, (status) => mountedRef.current && setLoadStatus(status));
    if (mountedRef.current) {
      setDownloaded(true);
      setActiveBackend(engine.backend);
    }
    return engine;
  }, [backend]);

  const handleError = useCallback((error: unknown) => {
    if (!mountedRef.current) return;
    if (error instanceof TtsCancelledError) {
      setPhase("idle");
      return;
    }
    console.error("[text-to-speech]", error);
    setPhase("error");
    setErrorMessage(describeError(error));
  }, []);

  const handlePreload = useCallback(async () => {
    if (phaseRef.current === "loading" || phaseRef.current === "synthesizing") return;
    setErrorMessage(null);
    try {
      await loadEngine();
      if (mountedRef.current) setPhase("idle");
    } catch (error) {
      handleError(error);
    }
  }, [handleError, loadEngine]);

  const handleGenerate = useCallback(async () => {
    if (!trimmed || previewLoading || phaseRef.current === "loading" || phaseRef.current === "synthesizing") return;
    setErrorMessage(null);
    previewAudioRef.current?.pause();
    try {
      const engine = await loadEngine();
      if (!mountedRef.current) return;
      setPhase("synthesizing");
      setProgress({ percent: 0, chunk: 0, chunks: 0 });
      const result = await engine.synthesize(trimmed, voice, { lang, steps, speed, silenceSeconds: silence }, (value) => {
        if (mountedRef.current) setProgress(value);
      });
      if (!mountedRef.current) return;
      const wav = encodeWav(result.wav, result.sampleRate);
      const item: SpeechResult = {
        id: nextIdRef.current++,
        url: URL.createObjectURL(wav),
        wav,
        text: trimmed,
        voice,
        lang,
        seconds: result.wav.length / result.sampleRate,
        elapsedMs: result.elapsedMs,
        backend: engine.backend,
      };
      setResults((prev) => [item, ...prev]);
      setPhase("idle");
    } catch (error) {
      handleError(error);
    }
  }, [handleError, lang, loadEngine, previewLoading, silence, speed, steps, trimmed, voice]);

  /** Plays `target` reading a short sentence, synthesising it once and replaying it from memory after that. */
  const handlePreview = useCallback(
    async (target: VoiceId) => {
      const audio = previewAudioRef.current;
      if (!audio) return;
      if (previewPlaying === target) {
        audio.pause();
        return;
      }
      audio.pause();
      if (!sampleSentence || previewLoading || phaseRef.current === "loading" || phaseRef.current === "synthesizing") return;
      const cache = previewCacheRef.current;
      const key = JSON.stringify([target, lang, speed, steps, sampleSentence]);
      let url = cache.get(key);
      if (!url) {
        setErrorMessage(null);
        setPreviewLoading(target);
        try {
          const engine = await loadEngine();
          if (!mountedRef.current) return;
          setPhase("idle");
          const result = await engine.synthesize(sampleSentence, target, { lang, steps, speed, silenceSeconds: 0 });
          if (!mountedRef.current) return;
          url = URL.createObjectURL(encodeWav(result.wav, result.sampleRate));
          cache.set(key, url);
          for (const [oldKey, oldUrl] of cache) {
            if (cache.size <= PREVIEW_CACHE_SIZE) break;
            URL.revokeObjectURL(oldUrl);
            cache.delete(oldKey);
          }
        } catch (error) {
          handleError(error);
          return;
        } finally {
          if (mountedRef.current) setPreviewLoading(null);
        }
      }
      audio.src = url;
      try {
        await audio.play();
        if (mountedRef.current) setPreviewPlaying(target);
      } catch (error) {
        if (mountedRef.current) setErrorMessage(`Không phát được bản nghe thử: ${describeError(error)}`);
      }
    },
    [handleError, lang, loadEngine, previewLoading, previewPlaying, sampleSentence, speed, steps],
  );

  const handleCancel = useCallback(() => {
    terminateTts();
    setActiveBackend(null);
    setPhase("idle");
  }, []);

  const handleClearModel = useCallback(async () => {
    try {
      await clearModelCache();
      if (!mountedRef.current) return;
      setDownloaded(false);
      setActiveBackend(null);
    } catch (error) {
      setErrorMessage(`Không xóa được mô hình: ${describeError(error)}`);
    }
  }, []);

  /** Inserts an expression tag at the caret (or replaces the selection), padded with spaces. */
  const insertTag = useCallback(
    (tag: string) => {
      const field = document.getElementById(TEXT_FIELD_ID) as HTMLTextAreaElement | null;
      const before = text.slice(0, field?.selectionStart ?? text.length);
      const after = text.slice(field?.selectionEnd ?? text.length);
      const insert = `${before && !/\s$/.test(before) ? " " : ""}${tag}${after && !/^\s/.test(after) ? " " : ""}`;
      setText(before + insert + after);
      const caret = before.length + insert.length;
      requestAnimationFrame(() => {
        field?.focus();
        field?.setSelectionRange(caret, caret);
      });
    },
    [text],
  );

  const removeResult = useCallback((id: number) => {
    setResults((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const downloadWav = useCallback((item: SpeechResult) => {
    downloadBlob(item.wav, `${slugify(item.text)}-${item.voice}.wav`);
  }, []);

  const downloadMp3 = useCallback(
    async (item: SpeechResult) => {
      updateResult(item.id, { mp3Busy: true });
      const outputPath = `/tts-${item.id}-${Date.now()}.mp3`;
      try {
        const ffmpeg = await getFFmpeg();
        await withInputFile(ffmpeg, new File([item.wav], `tts-${item.id}.wav`, { type: "audio/wav" }), (inputPath) =>
          execFFmpeg(ffmpeg, ["-i", inputPath, "-c:a", "libmp3lame", "-b:a", "192k", "-id3v2_version", "3", "-y", outputPath]),
        );
        const mp3 = await takeOutputFile(ffmpeg, outputPath, "audio/mpeg");
        downloadBlob(mp3, `${slugify(item.text)}-${item.voice}.mp3`);
      } catch (error) {
        if (mountedRef.current) setErrorMessage(`Không chuyển được sang MP3: ${describeError(error)}`);
      } finally {
        if (mountedRef.current) updateResult(item.id, { mp3Busy: false });
      }
    },
    [updateResult],
  );

  const loadingProgress =
    loadStatus?.stage === "download" && loadStatus.total > 0 ? Math.min(100, (loadStatus.loaded / loadStatus.total) * 100) : null;

  let statusBadge: { label: string; tone?: "info" | "attention" | "success" | "critical" };
  if (phase === "loading") statusBadge = { label: "Đang nạp mô hình", tone: "attention" };
  else if (phase === "synthesizing") statusBadge = { label: "Đang tạo giọng nói", tone: "info" };
  else if (phase === "error") statusBadge = { label: "Lỗi", tone: "critical" };
  else if (activeBackend) statusBadge = { label: "Sẵn sàng", tone: "success" };
  else statusBadge = { label: downloaded ? "Đã tải về máy" : "Chưa tải mô hình" };

  return (
    <Page
      fullWidth
      backAction={{ content: "Tổng quan", url: "/" }}
      title="Tạo giọng nói"
      subtitle="Chuyển văn bản thành giọng nói tự nhiên bằng Supertonic 3, chạy ngay trên máy của bạn (31 ngôn ngữ, có tiếng Việt)."
      primaryAction={{
        content: "Tạo giọng nói",
        onAction: handleGenerate,
        disabled: !trimmed || busy || previewLoading !== null,
        loading: busy,
      }}
      secondaryActions={busy ? [{ content: "Hủy", destructive: true, onAction: handleCancel }] : undefined}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Văn bản
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodySm" tone="subdued">
                      Chèn biểu cảm:
                    </Text>
                    <ButtonGroup variant="segmented">
                      {EXPRESSION_TAGS.map(({ tag, label }) => (
                        <Button key={tag} size="slim" onClick={() => insertTag(tag)} disabled={busy}>
                          {label}
                        </Button>
                      ))}
                    </ButtonGroup>
                  </InlineStack>
                </InlineStack>
                <TextField
                  id={TEXT_FIELD_ID}
                  label="Nội dung cần đọc"
                  labelHidden
                  value={text}
                  onChange={setText}
                  multiline={10}
                  maxHeight={480}
                  maxLength={MAX_CHARS}
                  showCharacterCount
                  autoComplete="off"
                  disabled={busy}
                  placeholder="Nhập hoặc dán văn bản cần chuyển thành giọng nói…"
                  helpText="Văn bản dài được tự động chia theo câu. Để trống một dòng giữa các đoạn để tách đoạn rõ ràng."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Kết quả
                  </Text>
                  {results.length > 0 && <Badge>{`${results.length} bản ghi`}</Badge>}
                </InlineStack>
                {results.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Âm thanh đã tạo sẽ hiển thị ở đây. Bạn có thể nghe thử, tải về WAV hoặc MP3.
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    {results.map((item, index) => (
                      <BlockStack key={item.id} gap="300">
                        {index > 0 && <Divider />}
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" breakWord>
                            {item.text.length > 220 ? `${item.text.slice(0, 220)}…` : item.text}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {`${voiceLabel(item.voice)} · ${LANGUAGE_OPTIONS.find((o) => o.value === item.lang)?.label ?? item.lang} · ${formatTimecode(item.seconds)} · tạo trong ${(item.elapsedMs / 1000).toFixed(1)} giây (${item.backend === "webgpu" ? "GPU" : "CPU"}) · ${formatBytes(item.wav.size)}`}
                          </Text>
                        </BlockStack>
                        <audio src={item.url} controls preload="metadata" style={{ width: "100%" }} />
                        <InlineStack gap="200" align="end">
                          <Button onClick={() => downloadWav(item)}>Tải WAV</Button>
                          <Button onClick={() => downloadMp3(item)} loading={item.mp3Busy}>
                            Tải MP3
                          </Button>
                          <Button tone="critical" variant="plain" onClick={() => removeResult(item.id)}>
                            Xóa
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Giọng đọc
                </Text>
                <Select
                  label="Ngôn ngữ của văn bản"
                  options={LANGUAGE_OPTIONS}
                  value={lang}
                  onChange={(value) => setLang(value as SupertonicLang)}
                  disabled={busy}
                  helpText="Chọn đúng ngôn ngữ để phát âm chuẩn nhất."
                />
                <BlockStack gap="200">
                  <Text as="p">Giọng</Text>
                  <InlineGrid columns={2} gap="200">
                    {VOICE_GRID.map((item) => {
                      const playingThis = previewPlaying === item.value;
                      return (
                        <InlineStack key={item.value} gap="100" wrap={false}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Button
                              fullWidth
                              pressed={voice === item.value}
                              onClick={() => setVoice(item.value)}
                              disabled={busy}
                            >
                              {item.label}
                            </Button>
                          </div>
                          <Tooltip content={playingThis ? "Dừng" : `Nghe thử ${item.label}`}>
                            <Button
                              icon={playingThis ? PauseCircleIcon : PlayIcon}
                              accessibilityLabel={playingThis ? "Dừng nghe thử" : `Nghe thử ${item.label}`}
                              onClick={() => void handlePreview(item.value)}
                              loading={previewLoading === item.value}
                              disabled={!sampleSentence || busy || (previewLoading !== null && previewLoading !== item.value)}
                            />
                          </Tooltip>
                        </InlineStack>
                      );
                    })}
                  </InlineGrid>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {!sampleSentence
                      ? "Nhập văn bản để nghe thử các giọng."
                      : `Bấm ▶ để nghe giọng đọc ${trimmed ? "đoạn mở đầu văn bản của bạn" : "một câu mẫu"} với ngôn ngữ và tốc độ đang chọn.${
                          activeBackend ? "" : downloaded ? " Lần đầu cần nạp mô hình." : " Lần đầu cần tải mô hình về máy."
                        }`}
                  </Text>
                </BlockStack>
                <RangeSlider
                  label="Tốc độ đọc"
                  value={speed}
                  min={0.7}
                  max={1.6}
                  step={0.05}
                  output
                  onChange={(value) => typeof value === "number" && setSpeed(value)}
                  disabled={busy}
                  helpText={`${speed.toFixed(2)}× — mặc định 1,05. Lớn hơn là đọc nhanh hơn.`}
                />
                <RangeSlider
                  label="Chất lượng (số bước khử nhiễu)"
                  value={steps}
                  min={2}
                  max={32}
                  step={1}
                  output
                  onChange={(value) => typeof value === "number" && setSteps(value)}
                  disabled={busy}
                  helpText="Mặc định 8. Nhiều bước hơn cho âm thanh sạch hơn nhưng tạo lâu hơn."
                />
                <RangeSlider
                  label="Khoảng nghỉ giữa các đoạn (giây)"
                  value={silence}
                  min={0}
                  max={2}
                  step={0.1}
                  output
                  onChange={(value) => typeof value === "number" && setSilence(value)}
                  disabled={busy}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Mô hình
                  </Text>
                  <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
                </InlineStack>

                <Select
                  label="Bộ xử lý"
                  options={BACKEND_OPTIONS}
                  value={backend}
                  onChange={(value) => setBackend(value as TtsBackend)}
                  disabled={busy}
                  helpText={
                    activeBackend
                      ? `Đang chạy trên ${activeBackend === "webgpu" ? "GPU (WebGPU)" : "CPU (WebAssembly)"}.`
                      : "Chọn CPU nếu GPU gặp lỗi hoặc cho âm thanh lạ."
                  }
                />

                {phase === "loading" && (
                  <BlockStack gap="200">
                    <ProgressBar progress={loadingProgress ?? 100} size="small" tone="primary" animated={loadingProgress === null} />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {describeLoad(loadStatus)}
                      {loadingProgress !== null && ` (${Math.round(loadingProgress)}%)`}
                    </Text>
                  </BlockStack>
                )}

                {phase === "synthesizing" && (
                  <BlockStack gap="200">
                    <ProgressBar progress={progress.percent} size="small" tone="primary" />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {progress.chunks > 1 ? `Đang đọc đoạn ${progress.chunk}/${progress.chunks}` : "Đang tạo giọng nói"}{" "}
                      {`${Math.round(progress.percent)}%`}
                    </Text>
                  </BlockStack>
                )}

                {!busy && downloaded === false && (
                  <Banner tone="info">
                    <p>
                      Lần đầu sử dụng cần tải mô hình (~{formatBytes(MODEL_DOWNLOAD_BYTES)}) từ Hugging Face. Mô hình được lưu
                      trên máy, các lần sau dùng ngay và không cần gửi văn bản đi đâu.
                    </p>
                  </Banner>
                )}

                {!busy && (
                  <InlineStack gap="200">
                    {!activeBackend && (
                      <Button onClick={handlePreload}>{downloaded ? "Nạp mô hình" : "Tải mô hình"}</Button>
                    )}
                    {downloaded && (
                      <Button tone="critical" variant="plain" onClick={handleClearModel}>
                        Xóa mô hình đã tải
                      </Button>
                    )}
                  </InlineStack>
                )}

                {busy && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Bấm Hủy để dừng. Lần tạo tiếp theo sẽ nạp lại mô hình từ bộ nhớ máy.
                  </Text>
                )}

                {errorMessage && (
                  <Banner tone="critical" title="Lỗi" onDismiss={() => setErrorMessage(null)}>
                    <p>{errorMessage}</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Box paddingInline="200">
              <Text as="p" variant="bodySm" tone="subdued">
                Mô hình Supertonic 3 của Supertone Inc. (giấy phép OpenRAIL-M). Hãy dùng giọng nói tạo ra một cách có trách
                nhiệm và không mạo danh người khác.
              </Text>
            </Box>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
