"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  DropZone,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { formatBytes, formatTimecode, parseTimecode, triggerDownload } from "../_lib/format";
import {
  FFmpegCrashError,
  describeError,
  execFFmpeg,
  getFFmpeg,
  isTerminationError,
  probeMedia,
  takeOutputFile,
  terminateFFmpeg,
  withInputFile,
  type MediaEngine,
  type ProbeResult,
} from "../_lib/ffmpeg";

type FormatValue = "copy" | "mp3" | "m4a" | "ogg" | "wav" | "flac";
type LossyFormat = "mp3" | "m4a" | "ogg";
type Quality = "high" | "balanced" | "small";
type Channels = "original" | "2" | "1";
type ItemStatus = "analyzing" | "ready" | "extracting" | "done" | "error";

interface AudioTrack {
  /** Absolute stream index in the source file, used with `-map 0:<index>`. */
  index: number;
  codec: string;
  channels?: number;
  sampleRate?: number;
  bitRate?: number;
  language?: string;
  title?: string;
  isDefault: boolean;
}

interface ExtractResult {
  url: string;
  name: string;
  size: number;
  /** Codec of the output file, e.g. "AAC". */
  codecLabel: string;
  /** The audio was stream-copied, not re-encoded. */
  copied: boolean;
  /** Records which settings and track produced the file, so changing either triggers a redo. */
  settingsKey: string;
}

interface ExtractItem {
  id: number;
  file: File;
  status: ItemStatus;
  progress: number;
  duration?: number;
  tracks: AudioTrack[];
  /** Stream index of the chosen track. */
  trackIndex?: number;
  error?: string;
  result?: ExtractResult;
}

interface OutputFormat {
  value: FormatValue;
  label: string;
  hint: string;
}

interface ExtractSettings {
  format: FormatValue;
  quality: Quality;
  channels: Channels;
  sampleRate: string;
  normalize: boolean;
  start: number;
  end: number | null;
}

interface OutputTarget {
  ext: string;
  mime: string;
}

const FORMATS: OutputFormat[] = [
  { value: "copy", label: "Giữ nguyên âm thanh gốc",
    hint: "Không mã hóa lại: gần như tức thì và không giảm chất lượng. Đuôi file theo codec gốc (AAC → .m4a, MP3 → .mp3, Opus → .opus…)." },
  { value: "mp3", label: "MP3", hint: "Phổ biến nhất – phát được trên mọi thiết bị và phần mềm." },
  { value: "m4a", label: "M4A (AAC)", hint: "Nhẹ hơn MP3 ở cùng chất lượng, hợp với iPhone, Mac và mạng xã hội." },
  { value: "ogg", label: "OGG (Vorbis)", hint: "Định dạng mở, dùng tốt trên web và Android." },
  { value: "wav", label: "WAV (không nén)", hint: "Dung lượng lớn, hợp để dựng và chỉnh sửa âm thanh." },
  { value: "flac", label: "FLAC (nén không mất dữ liệu)", hint: "Giữ nguyên chất lượng như WAV nhưng nhẹ hơn khoảng một nửa." },
];

const FORMAT_OPTIONS = [
  { title: "Không mã hóa lại", options: [{ label: FORMATS[0].label, value: "copy" }] },
  { title: "Nén (dung lượng nhỏ)", options: FORMATS.slice(1, 4).map(({ label, value }) => ({ label, value })) },
  { title: "Không mất chất lượng", options: FORMATS.slice(4).map(({ label, value }) => ({ label, value })) },
];

const OUTPUT_TARGETS: Record<Exclude<FormatValue, "copy">, OutputTarget> = {
  mp3: { ext: "mp3", mime: "audio/mpeg" },
  m4a: { ext: "m4a", mime: "audio/mp4" },
  ogg: { ext: "ogg", mime: "audio/ogg" },
  wav: { ext: "wav", mime: "audio/wav" },
  flac: { ext: "flac", mime: "audio/flac" },
};

// Container for stream-copying each source codec. Anything else (or anything a container
// refuses) goes into Matroska audio, which accepts every codec.
const WAV: OutputTarget = { ext: "wav", mime: "audio/wav" };
const COPY_TARGETS: Record<string, OutputTarget> = {
  aac: { ext: "m4a", mime: "audio/mp4" },
  alac: { ext: "m4a", mime: "audio/mp4" },
  mp3: { ext: "mp3", mime: "audio/mpeg" },
  mp2: { ext: "mp2", mime: "audio/mpeg" },
  opus: { ext: "opus", mime: "audio/ogg" },
  vorbis: { ext: "ogg", mime: "audio/ogg" },
  flac: { ext: "flac", mime: "audio/flac" },
  ac3: { ext: "ac3", mime: "audio/ac3" },
  eac3: { ext: "eac3", mime: "audio/eac3" },
  pcm_u8: WAV,
  pcm_s16le: WAV,
  pcm_s24le: WAV,
  pcm_s32le: WAV,
  pcm_f32le: WAV,
};
const MKA: OutputTarget = { ext: "mka", mime: "audio/x-matroska" };

const CODEC_NAMES: Record<string, string> = {
  aac: "AAC",
  alac: "ALAC",
  mp3: "MP3",
  mp2: "MP2",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  wmav2: "WMA",
  amr_nb: "AMR",
};

const OUTPUT_CODEC_LABELS: Record<Exclude<FormatValue, "copy">, string> = {
  mp3: "MP3",
  m4a: "AAC",
  ogg: "Vorbis",
  wav: "PCM 16-bit",
  flac: "FLAC",
};

// kbps per quality level. Vorbis is variable bitrate, so its numbers are approximate.
const BITRATES: Record<LossyFormat, Record<Quality, number>> = {
  mp3: { high: 320, balanced: 192, small: 128 },
  m4a: { high: 256, balanced: 160, small: 96 },
  ogg: { high: 256, balanced: 160, small: 112 },
};
const VORBIS_QUALITY: Record<Quality, string> = { high: "8", balanced: "5", small: "3" };

const CHANNEL_OPTIONS = [
  { label: "Giữ nguyên", value: "original" },
  { label: "Stereo (2 kênh)", value: "2" },
  { label: "Mono (1 kênh)", value: "1" },
];

const SAMPLE_RATE_OPTIONS = [
  { label: "Giữ nguyên", value: "original" },
  { label: "48 kHz (video)", value: "48000" },
  { label: "44,1 kHz (nhạc, CD)", value: "44100" },
  { label: "22,05 kHz", value: "22050" },
  { label: "16 kHz (giọng nói, nhận dạng giọng)", value: "16000" },
];

const STATUS_BADGE: Record<ItemStatus, { label: string; tone?: "info" | "attention" | "success" | "critical" }> = {
  analyzing: { label: "Đang đọc file", tone: "info" },
  ready: { label: "Chờ tách" },
  extracting: { label: "Đang tách", tone: "attention" },
  done: { label: "Xong", tone: "success" },
  error: { label: "Lỗi", tone: "critical" },
};

let nextItemId = 1;

const isLossy = (format: FormatValue): format is LossyFormat => format === "mp3" || format === "m4a" || format === "ogg";

function codecName(codec: string) {
  return CODEC_NAMES[codec] ?? (codec.startsWith("pcm_") ? "PCM" : codec.toUpperCase());
}

function channelLabel(channels: number) {
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels} kênh`;
}

function trackLabel(track: AudioTrack, position: number) {
  return [
    `Track ${position + 1}`,
    codecName(track.codec),
    track.channels && channelLabel(track.channels),
    track.sampleRate && `${(track.sampleRate / 1000).toLocaleString("vi-VN")} kHz`,
    track.bitRate && `${Math.round(track.bitRate / 1000)} kbps`,
    track.language?.toUpperCase(),
    track.title && `“${track.title}”`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function audioTracks(probe: ProbeResult): AudioTrack[] {
  return (probe.streams ?? [])
    .filter((stream) => stream.codec_type === "audio")
    .map((stream) => ({
      index: stream.index,
      codec: stream.codec_name ?? "unknown",
      channels: stream.channels,
      sampleRate: Number(stream.sample_rate) || undefined,
      bitRate: Number(stream.bit_rate ?? stream.tags?.BPS) || undefined,
      language: stream.tags?.language && stream.tags.language !== "und" ? stream.tags.language : undefined,
      title: stream.tags?.title,
      isDefault: stream.disposition?.default === 1,
    }));
}

function codecArgs({ format, quality }: ExtractSettings): string[] {
  switch (format) {
    case "mp3":
      // ID3v2.3 tags are what Windows Explorer and older players read.
      return ["-c:a", "libmp3lame", "-b:a", `${BITRATES.mp3[quality]}k`, "-id3v2_version", "3"];
    case "m4a":
      return ["-c:a", "aac", "-b:a", `${BITRATES.m4a[quality]}k`, "-movflags", "+faststart"];
    case "ogg":
      return ["-c:a", "libvorbis", "-q:a", VORBIS_QUALITY[quality]];
    case "wav":
      return ["-c:a", "pcm_s16le"];
    case "flac":
      return ["-c:a", "flac"];
    default:
      return ["-c:a", "copy"];
  }
}

function buildArgs(settings: ExtractSettings, track: AudioTrack, input: string, output: string): string[] {
  const { start, end, channels, sampleRate, normalize } = settings;
  // Seeking before -i jumps straight to the start point instead of decoding up to it.
  const args = [...(start > 0 ? ["-ss", start.toFixed(3)] : []), "-i", input, "-map", `0:${track.index}`];
  if (end !== null) args.push("-t", (end - start).toFixed(3));
  if (settings.format !== "copy") {
    if (normalize) args.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
    if (channels !== "original") args.push("-ac", channels);
    // loudnorm upsamples to 192 kHz internally, so pin the rate back to the source's (MP3 tops out at 48 kHz).
    const rate = sampleRate !== "original" ? sampleRate : normalize ? String(Math.min(track.sampleRate ?? 48000, 48000)) : null;
    if (rate) args.push("-ar", rate);
  }
  return [...args, ...codecArgs(settings), "-y", output];
}

function outputName(item: ExtractItem, track: AudioTrack, ext: string) {
  const base = item.file.name.replace(/\.[^.]+$/, "") || "audio";
  const position = item.tracks.indexOf(track);
  return `${base}${item.tracks.length > 1 ? `_track${position + 1}` : ""}.${ext}`;
}

async function deleteQuietly(engine: MediaEngine, path: string) {
  try {
    await engine.deleteFile(path);
  } catch {
    // The file may not exist if FFmpeg failed before writing it.
  }
}

export default function AudioExtractorPage() {
  const [items, setItems] = useState<ExtractItem[]>([]);
  const [format, setFormat] = useState<FormatValue>("mp3");
  const [quality, setQuality] = useState<Quality>("high");
  const [channels, setChannels] = useState<Channels>("original");
  const [sampleRate, setSampleRate] = useState("original");
  const [normalize, setNormalize] = useState(false);
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [busy, setBusy] = useState(false);
  const [stageDetail, setStageDetail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);

  const urlsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);
  // Files are analysed strictly one at a time.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  const formatInfo = FORMATS.find((f) => f.value === format) ?? FORMATS[0];
  const copy = format === "copy";

  // An empty start means "from the beginning"; an empty end means "to the end".
  const start = startText.trim() ? parseTimecode(startText) : 0;
  const end = endText.trim() ? parseTimecode(endText) : undefined;
  const trimErrors = {
    start: start === null ? "Sai định dạng thời gian" : undefined,
    end:
      end === null
        ? "Sai định dạng thời gian"
        : end !== undefined && start !== null && end <= start
          ? "Phải sau điểm bắt đầu"
          : undefined,
  };
  const trimValid = !trimErrors.start && !trimErrors.end;

  const settingsKey = [
    format,
    isLossy(format) && quality,
    !copy && channels,
    !copy && sampleRate,
    !copy && normalize,
    start,
    end,
  ].join("|");

  useEffect(() => {
    mountedRef.current = true;
    const urls = urlsRef.current;
    return () => {
      mountedRef.current = false;
      if (busyRef.current) terminateFFmpeg();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  const updateItem = useCallback((id: number, patch: Partial<ExtractItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const releaseResult = useCallback((item: ExtractItem) => {
    if (!item.result) return;
    URL.revokeObjectURL(item.result.url);
    urlsRef.current.delete(item.result.url);
  }, []);

  const analyze = useCallback(
    (item: ExtractItem) => {
      const task = async () => {
        try {
          const ffmpeg = await getFFmpeg();
          const probe = await withInputFile(ffmpeg, item.file, (inputPath) => probeMedia(ffmpeg, inputPath));
          if (!mountedRef.current) return;
          const tracks = audioTracks(probe);
          const duration = Number(probe.format?.duration) || undefined;
          if (tracks.length === 0) {
            updateItem(item.id, { status: "error", duration, error: "Video này không có âm thanh." });
            return;
          }
          const chosen = tracks.find((track) => track.isDefault) ?? tracks[0];
          updateItem(item.id, { status: "ready", duration, tracks, trackIndex: chosen.index });
        } catch (error) {
          console.error("[audio-extractor] analyze", item.file.name, error);
          if (mountedRef.current) updateItem(item.id, { status: "error", error: `Không đọc được file: ${describeError(error)}` });
        }
      };
      const run = chainRef.current.then(task, task);
      chainRef.current = run.catch(() => undefined);
      return run;
    },
    [updateItem],
  );

  const handleDrop = useCallback(
    (_all: File[], accepted: File[], rejectedFiles: File[]) => {
      const isVideo = (file: File) =>
        file.type.startsWith("video/") || /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|3gp|mpg|mpeg|ts|mts)$/i.test(file.name);
      const files = [...accepted, ...rejectedFiles];
      setRejected(files.filter((file) => !isVideo(file)).map((file) => file.name));
      const added: ExtractItem[] = files
        .filter(isVideo)
        .map((file) => ({ id: nextItemId++, file, status: "analyzing", progress: 0, tracks: [] }));
      setItems((prev) => [...prev, ...added]);
      added.forEach((item) => void analyze(item));
    },
    [analyze],
  );

  const removeItem = useCallback(
    (item: ExtractItem) => {
      releaseResult(item);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    },
    [releaseResult],
  );

  const clearAll = useCallback(() => {
    items.forEach(releaseResult);
    setItems([]);
    setNotice(null);
  }, [items, releaseResult]);

  const itemKey = (item: ExtractItem) => `${settingsKey}|${item.trackIndex}`;
  const isUpToDate = (item: ExtractItem) => item.status === "done" && item.result?.settingsKey === itemKey(item);
  const analyzing = items.some((item) => item.status === "analyzing");
  // Files with a usable audio track but no up-to-date result. Files that failed analysis have no tracks.
  const pending = items.filter((item) => item.tracks.length > 0 && item.status !== "analyzing" && !isUpToDate(item));
  const reextract = pending.length === 0 && items.some((item) => item.status === "done");

  const handleExtract = useCallback(async () => {
    const queue = reextract ? items.filter((item) => item.status === "done") : pending;
    if (busyRef.current || queue.length === 0 || !trimValid) return;
    const settings: ExtractSettings = { format, quality, channels, sampleRate, normalize, start: start ?? 0, end: end ?? null };
    const runKey = settingsKey;

    // Extracting again replaces any earlier output for these files.
    queue.forEach(releaseResult);
    setItems((prev) =>
      prev.map((item) =>
        queue.some((q) => q.id === item.id) ? { ...item, status: "ready", progress: 0, error: undefined, result: undefined } : item,
      ),
    );
    setNotice(null);
    setBusy(true);
    busyRef.current = true;
    cancelledRef.current = false;

    let extracted = 0;
    try {
      for (const [index, item] of queue.entries()) {
        if (!mountedRef.current || cancelledRef.current) return;
        const track = item.tracks.find((t) => t.index === item.trackIndex) ?? item.tracks[0];
        if (item.duration !== undefined && settings.start >= item.duration) {
          updateItem(item.id, { status: "error", error: `Điểm bắt đầu vượt quá độ dài video (${formatTimecode(item.duration)}).` });
          continue;
        }
        // Fetched per file: if FFmpeg crashed on the previous file, this loads a fresh worker.
        const ffmpeg = await getFFmpeg(setStageDetail);
        setStageDetail(`Đang tách file ${index + 1}/${queue.length}: ${item.file.name}`);
        updateItem(item.id, { status: "extracting", progress: 0 });

        const segmentEnd = Math.min(settings.end ?? Infinity, item.duration ?? Infinity);
        const length = Number.isFinite(segmentEnd) ? segmentEnd - settings.start : null;
        let target: OutputTarget = settings.format === "copy" ? (COPY_TARGETS[track.codec] ?? MKA) : OUTPUT_TARGETS[settings.format];
        const outputPath = (t: OutputTarget) => `/audio-${item.id}.${t.ext}`;

        try {
          await withInputFile(ffmpeg, item.file, async (inputPath) => {
            const run = (t: OutputTarget) =>
              execFFmpeg(ffmpeg, buildArgs(settings, track, inputPath, outputPath(t)), {
                onTime: (seconds) => {
                  if (length) updateItem(item.id, { progress: Math.min(100, (seconds / length) * 100) });
                },
              });
            try {
              await run(target);
            } catch (error) {
              // A container that refuses the source codec: copy into Matroska audio instead.
              if (settings.format !== "copy" || target === MKA || isTerminationError(error) || error instanceof FFmpegCrashError) {
                throw error;
              }
              await deleteQuietly(ffmpeg, outputPath(target));
              target = MKA;
              await run(target);
            }
          });

          const blob = await takeOutputFile(ffmpeg, outputPath(target), target.mime);
          if (!mountedRef.current) return;
          const url = URL.createObjectURL(blob);
          urlsRef.current.add(url);
          extracted++;
          updateItem(item.id, {
            status: "done",
            progress: 100,
            result: {
              url,
              name: outputName(item, track, target.ext),
              size: blob.size,
              codecLabel: settings.format === "copy" ? codecName(track.codec) : OUTPUT_CODEC_LABELS[settings.format],
              copied: settings.format === "copy",
              settingsKey: `${runKey}|${track.index}`,
            },
          });
        } catch (error) {
          if (cancelledRef.current || isTerminationError(error)) throw error;
          console.error("[audio-extractor]", item.file.name, error);
          await deleteQuietly(ffmpeg, outputPath(target));
          updateItem(item.id, { status: "error", progress: 0, error: describeError(error) });
        }
      }
      if (mountedRef.current) setNotice(`Đã tách âm thanh ${extracted}/${queue.length} file.`);
    } catch (error) {
      if (!mountedRef.current) return;
      if (cancelledRef.current || isTerminationError(error)) {
        setItems((prev) => prev.map((item) => (item.status === "extracting" ? { ...item, status: "ready", progress: 0 } : item)));
        setNotice("Đã hủy. Các file đã tách xong vẫn được giữ lại.");
      } else {
        console.error("[audio-extractor]", error);
        setNotice(describeError(error, "Không tải được FFmpeg."));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setStageDetail("");
      }
    }
  }, [channels, end, format, items, normalize, pending, quality, reextract, releaseResult, sampleRate, settingsKey, start, trimValid, updateItem]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    terminateFFmpeg();
  }, []);

  const doneItems = items.filter((item) => item.result);

  const handleDownloadAll = useCallback(async () => {
    for (const item of doneItems) {
      triggerDownload(item.result!.url, item.result!.name);
      // Browsers throttle bursts of downloads; space them out slightly.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }, [doneItems]);

  const workItems = items.filter((item) => item.tracks.length > 0);
  const overallProgress =
    workItems.length === 0
      ? 0
      : workItems.reduce((sum, item) => sum + (item.status === "done" ? 100 : item.progress), 0) / workItems.length;
  const primaryCount = reextract ? doneItems.length : pending.length;

  const qualityOptions = isLossy(format)
    ? [
        { label: `Cao · ${format === "ogg" ? "~" : ""}${BITRATES[format].high} kbps`, value: "high" },
        { label: `Cân bằng · ${format === "ogg" ? "~" : ""}${BITRATES[format].balanced} kbps`, value: "balanced" },
        { label: `Nhẹ · ${format === "ogg" ? "~" : ""}${BITRATES[format].small} kbps`, value: "small" },
      ]
    : [];

  return (
    <Page
      fullWidth
      backAction={{ content: "Tổng quan", url: "/" }}
      title="Tách âm thanh"
      subtitle="Lấy riêng phần âm thanh từ video: giữ nguyên chất lượng gốc hoặc xuất MP3, M4A, OGG, WAV, FLAC. Xử lý ngay trên máy, không tải lên máy chủ."
      primaryAction={{
        content: reextract ? "Tách lại" : primaryCount > 1 ? `Tách âm thanh ${primaryCount} file` : "Tách âm thanh",
        onAction: handleExtract,
        disabled: primaryCount === 0 || busy || analyzing || !trimValid,
        loading: busy,
      }}
      secondaryActions={
        items.length > 0 ? [{ content: "Xóa tất cả", destructive: true, onAction: clearAll, disabled: busy || analyzing }] : undefined
      }
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  File nguồn
                </Text>
                <DropZone accept="video/*" type="file" allowMultiple onDrop={handleDrop} disabled={busy} label="Video" labelHidden>
                  <DropZone.FileUpload
                    actionTitle="Chọn video"
                    actionHint="Có thể chọn nhiều file: MP4, MOV, MKV, WebM, AVI, WMV, FLV, 3GP…"
                  />
                </DropZone>
                {rejected.length > 0 && (
                  <Banner tone="warning" onDismiss={() => setRejected([])}>
                    <p>Bỏ qua file không phải video: {rejected.join(", ")}</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Danh sách file ({items.length})
                  </Text>
                  {doneItems.length > 1 && (
                    <Button onClick={handleDownloadAll} disabled={busy}>
                      Tải tất cả
                    </Button>
                  )}
                </InlineStack>

                {items.length === 0 ? (
                  <Box paddingBlock="400">
                    <Text as="p" tone="subdued" alignment="center">
                      Chưa có file nào. Thêm video ở phía trên để bắt đầu.
                    </Text>
                  </Box>
                ) : (
                  items.map((item, index) => {
                    const badge =
                      item.status === "done" && !isUpToDate(item)
                        ? { label: "Cài đặt đã đổi", tone: "info" as const }
                        : STATUS_BADGE[item.status];
                    const details = [
                      formatBytes(item.file.size),
                      item.duration !== undefined && formatTimecode(item.duration, { fractional: false }),
                      item.tracks.length > 1 && `${item.tracks.length} track âm thanh`,
                    ].filter(Boolean);
                    return (
                      <BlockStack key={item.id} gap="200">
                        {index > 0 && <Divider />}
                        <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
                          <BlockStack gap="050">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="p" fontWeight="semibold" breakWord>
                                {item.file.name}
                              </Text>
                              <Badge tone={badge.tone}>{badge.label}</Badge>
                            </InlineStack>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {details.join(" · ")}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="200" wrap={false}>
                            {item.result && (
                              <Button url={item.result.url} download={item.result.name} variant="primary">
                                Tải xuống
                              </Button>
                            )}
                            <Button
                              icon={DeleteIcon}
                              variant="tertiary"
                              tone="critical"
                              accessibilityLabel={`Xóa ${item.file.name}`}
                              onClick={() => removeItem(item)}
                              disabled={busy}
                            />
                          </InlineStack>
                        </InlineStack>

                        {item.tracks.length > 1 ? (
                          <Select
                            label="Track âm thanh"
                            options={item.tracks.map((track, position) => ({
                              label: trackLabel(track, position) + (track.isDefault ? " (mặc định)" : ""),
                              value: String(track.index),
                            }))}
                            value={String(item.trackIndex)}
                            onChange={(value) => updateItem(item.id, { trackIndex: Number(value) })}
                            disabled={busy}
                          />
                        ) : (
                          item.tracks.length === 1 && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              Âm thanh gốc: {trackLabel(item.tracks[0], 0).replace(/^Track 1 · /, "")}
                            </Text>
                          )
                        )}

                        {item.status === "extracting" && <ProgressBar progress={item.progress} size="small" tone="primary" />}
                        {item.error && (
                          <Text as="p" variant="bodySm" tone="critical">
                            {item.error}
                          </Text>
                        )}
                        {item.result && (
                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">
                              → {item.result.name} · {formatBytes(item.result.size)} · {item.result.codecLabel}
                              {item.result.copied ? " · giữ nguyên chất lượng gốc" : ""}
                            </Text>
                            <audio controls preload="none" src={item.result.url} style={{ width: "100%" }} />
                          </BlockStack>
                        )}
                      </BlockStack>
                    );
                  })
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
                  Định dạng đầu ra
                </Text>
                <Select
                  label="Xuất ra"
                  options={FORMAT_OPTIONS}
                  value={format}
                  onChange={(value) => setFormat(value as FormatValue)}
                  disabled={busy}
                  helpText={formatInfo.hint}
                />
                {isLossy(format) && (
                  <Select
                    label="Chất lượng"
                    options={qualityOptions}
                    value={quality}
                    onChange={(value) => setQuality(value as Quality)}
                    disabled={busy}
                  />
                )}
                {!copy && (
                  <>
                    <Select
                      label="Kênh âm thanh"
                      options={CHANNEL_OPTIONS}
                      value={channels}
                      onChange={(value) => setChannels(value as Channels)}
                      disabled={busy}
                    />
                    <Select
                      label="Tần số mẫu"
                      options={SAMPLE_RATE_OPTIONS}
                      value={sampleRate}
                      onChange={setSampleRate}
                      disabled={busy}
                    />
                    <Checkbox
                      label="Chuẩn hóa âm lượng"
                      helpText="Đưa âm lượng về mức chuẩn (-16 LUFS) của podcast và mạng xã hội: đoạn nhỏ được nâng lên, đoạn quá to được hạ xuống."
                      checked={normalize}
                      onChange={setNormalize}
                      disabled={busy}
                    />
                  </>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Cắt đoạn (tùy chọn)
                </Text>
                <InlineGrid columns={2} gap="200">
                  <TextField
                    label="Bắt đầu"
                    placeholder="00:00"
                    value={startText}
                    onChange={setStartText}
                    error={trimErrors.start}
                    autoComplete="off"
                    disabled={busy}
                  />
                  <TextField
                    label="Kết thúc"
                    placeholder="Hết video"
                    value={endText}
                    onChange={setEndText}
                    error={trimErrors.end}
                    autoComplete="off"
                    disabled={busy}
                  />
                </InlineGrid>
                <Text as="p" variant="bodySm" tone="subdued">
                  Để trống để lấy toàn bộ. Ví dụ: 1:30, 01:02:03. Áp dụng cho mọi file trong danh sách.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Trạng thái
                  </Text>
                  {busy ? (
                    <Badge tone="attention">Đang xử lý</Badge>
                  ) : workItems.length > 0 && workItems.every((item) => item.result) ? (
                    <Badge tone="success">Hoàn tất</Badge>
                  ) : (
                    <Badge>Sẵn sàng</Badge>
                  )}
                </InlineStack>
                {busy ? (
                  <BlockStack gap="200">
                    <ProgressBar progress={overallProgress} size="small" tone="primary" />
                    <Text as="p" variant="bodySm" tone="subdued" breakWord>
                      {stageDetail}
                    </Text>
                    <InlineStack align="end">
                      <Button tone="critical" variant="plain" onClick={handleCancel}>
                        Hủy
                      </Button>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {items.length === 0
                      ? "Thêm video để bắt đầu."
                      : analyzing
                        ? "Đang đọc thông tin âm thanh…"
                        : `${doneItems.length}/${workItems.length} file đã tách xong.`}
                  </Text>
                )}
                {notice && (
                  <Banner tone="info" onDismiss={() => setNotice(null)}>
                    <p>{notice}</p>
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
