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
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Select,
  Text,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { formatBytes, triggerDownload } from "../_lib/format";
import {
  FFmpegExecError,
  describeError,
  execFFmpeg,
  getFFmpeg,
  isTerminationError,
  parseDurationLog,
  takeOutputFile,
  terminateFFmpeg,
  withInputFile,
} from "../_lib/ffmpeg";

type FormatKind = "video" | "gif" | "audio";
type Quality = "high" | "balanced" | "small";
type Resolution = "original" | "1080" | "720" | "480";
type ItemStatus = "pending" | "converting" | "done" | "error";

interface OutputFormat {
  value: string;
  label: string;
  kind: FormatKind;
  ext: string;
  mime: string;
  /** Short description shown under the select. */
  hint: string;
  /** Whether H.264/AAC style sources can usually be remuxed into this container without re-encoding. */
  remuxable?: boolean;
}

const FORMATS: OutputFormat[] = [
  { value: "mp4", label: "MP4 (H.264 + AAC)", kind: "video", ext: "mp4", mime: "video/mp4", remuxable: true,
    hint: "Phổ biến nhất – xem được trên mọi thiết bị, trình duyệt và mạng xã hội." },
  { value: "mov", label: "MOV (H.264 + AAC)", kind: "video", ext: "mov", mime: "video/quicktime", remuxable: true,
    hint: "Định dạng QuickTime, hợp với iPhone, Mac, Final Cut, Premiere." },
  { value: "mkv", label: "MKV (H.264 + AAC)", kind: "video", ext: "mkv", mime: "video/x-matroska", remuxable: true,
    hint: "Container linh hoạt, hợp để lưu trữ và xem bằng VLC." },
  { value: "webm", label: "WebM (VP8 + Vorbis)", kind: "video", ext: "webm", mime: "video/webm",
    hint: "Định dạng mở cho web, dùng tốt trong thẻ <video> của trình duyệt." },
  { value: "avi", label: "AVI (MPEG-4 + MP3)", kind: "video", ext: "avi", mime: "video/x-msvideo",
    hint: "Cho đầu DVD, TV và phần mềm cũ." },
  { value: "gif", label: "GIF động", kind: "gif", ext: "gif", mime: "image/gif",
    hint: "Ảnh động không tiếng. Chỉ nên dùng cho clip ngắn (dưới ~30 giây)." },
  { value: "mp3", label: "MP3 (chỉ âm thanh)", kind: "audio", ext: "mp3", mime: "audio/mpeg",
    hint: "Tách âm thanh ra file MP3." },
  { value: "m4a", label: "M4A / AAC (chỉ âm thanh)", kind: "audio", ext: "m4a", mime: "audio/mp4",
    hint: "Âm thanh AAC, nhẹ và chất lượng tốt, hợp với thiết bị Apple." },
  { value: "wav", label: "WAV (chỉ âm thanh)", kind: "audio", ext: "wav", mime: "audio/wav",
    hint: "Âm thanh không nén, dung lượng lớn – hợp để chỉnh sửa." },
];

const FORMAT_OPTIONS = [
  { title: "Video", options: FORMATS.filter((f) => f.kind === "video").map(({ label, value }) => ({ label, value })) },
  { title: "Ảnh động", options: FORMATS.filter((f) => f.kind === "gif").map(({ label, value }) => ({ label, value })) },
  { title: "Âm thanh", options: FORMATS.filter((f) => f.kind === "audio").map(({ label, value }) => ({ label, value })) },
];

const QUALITY_OPTIONS = [
  { label: "Cao", value: "high" },
  { label: "Cân bằng", value: "balanced" },
  { label: "Nhẹ (dung lượng nhỏ)", value: "small" },
];

const RESOLUTION_OPTIONS = [
  { label: "Giữ nguyên", value: "original" },
  { label: "Tối đa 1080p", value: "1080" },
  { label: "Tối đa 720p", value: "720" },
  { label: "Tối đa 480p", value: "480" },
];

// Encoder settings per quality level.
const H264_CRF: Record<Quality, string> = { high: "20", balanced: "23", small: "28" };
// VP8 in constrained-quality mode: CRF plus a bitrate ceiling. (VP9 and Opus crash in the
// current @ffmpeg/core build, so WebM uses VP8 + Vorbis.)
const VP8_CRF: Record<Quality, string> = { high: "6", balanced: "10", small: "20" };
const VP8_MAX_BITRATE: Record<Quality, string> = { high: "4M", balanced: "2M", small: "1M" };
const VORBIS_QUALITY: Record<Quality, string> = { high: "6", balanced: "4", small: "3" };
const MPEG4_QSCALE: Record<Quality, string> = { high: "3", balanced: "5", small: "8" };
const AUDIO_BITRATE: Record<Quality, string> = { high: "192k", balanced: "128k", small: "96k" };
const MP3_BITRATE: Record<Quality, string> = { high: "320k", balanced: "192k", small: "128k" };
const GIF_WIDTH: Record<Quality, number> = { high: 640, balanced: 480, small: 320 };
const GIF_FPS: Record<Quality, number> = { high: 15, balanced: 12, small: 10 };

interface ConvertSettings {
  format: OutputFormat;
  quality: Quality;
  resolution: Resolution;
  mute: boolean;
}

interface QueueItem {
  id: number;
  file: File;
  status: ItemStatus;
  progress: number;
  error?: string;
  /** `settingsKey` records which settings produced the file, so changed settings trigger a redo. */
  result?: { url: string; name: string; size: number; remuxed: boolean; settingsKey: string };
}

let nextItemId = 1;

function isUpToDate(item: QueueItem, settingsKey: string) {
  return item.status === "done" && item.result?.settingsKey === settingsKey;
}

function canRemux({ format, resolution }: ConvertSettings) {
  return Boolean(format.remuxable) && resolution === "original";
}

function buildArgs(settings: ConvertSettings, input: string, output: string, remux: boolean): string[] {
  const { format, quality, resolution, mute } = settings;

  if (remux) {
    // Copy the streams as-is into the new container: near-instant and lossless.
    return ["-i", input, "-map", "0:v?", ...(mute ? ["-an"] : ["-map", "0:a?"]), "-c", "copy", "-y", output];
  }

  if (format.kind === "audio") {
    const codec =
      format.value === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", MP3_BITRATE[quality]]
        : format.value === "m4a"
          ? ["-c:a", "aac", "-b:a", AUDIO_BITRATE[quality]]
          : ["-c:a", "pcm_s16le"];
    return ["-i", input, "-vn", ...codec, "-y", output];
  }

  if (format.kind === "gif") {
    // Two-pass palette in one filter graph gives far better colours than the default GIF palette.
    const width = GIF_WIDTH[quality];
    const filter =
      `fps=${GIF_FPS[quality]},scale='min(${width},iw)':-2:flags=lanczos,` +
      "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5";
    return ["-i", input, "-filter_complex", filter, "-loop", "0", "-y", output];
  }

  // Never upscale: cap the height and keep the width even for the encoders.
  const scale = resolution === "original" ? [] : ["-vf", `scale=-2:'min(${resolution},ih)'`];
  const audio = mute ? ["-an"] : [];
  let codecs: string[];
  switch (format.value) {
    case "webm":
      codecs = [
        "-c:v", "libvpx", "-crf", VP8_CRF[quality], "-b:v", VP8_MAX_BITRATE[quality],
        "-deadline", "realtime", "-cpu-used", "8",
        ...(mute ? [] : ["-c:a", "libvorbis", "-q:a", VORBIS_QUALITY[quality]]),
      ];
      break;
    case "avi":
      codecs = [
        "-c:v", "mpeg4", "-q:v", MPEG4_QSCALE[quality], "-vtag", "xvid",
        ...(mute ? [] : ["-c:a", "libmp3lame", "-b:a", AUDIO_BITRATE[quality]]),
      ];
      break;
    default:
      codecs = [
        "-c:v", "libx264", "-preset", "superfast", "-crf", H264_CRF[quality], "-pix_fmt", "yuv420p",
        ...(mute ? [] : ["-c:a", "aac", "-b:a", AUDIO_BITRATE[quality]]),
      ];
  }
  return ["-i", input, ...scale, ...codecs, ...audio, "-y", output];
}

function outputName(file: File, format: OutputFormat) {
  const base = file.name.replace(/\.[^.]+$/, "") || "video";
  const sameExt = file.name.toLowerCase().endsWith(`.${format.ext}`);
  return `${base}${sameExt ? "_converted" : ""}.${format.ext}`;
}

const STATUS_BADGE: Record<ItemStatus, { label: string; tone?: "info" | "attention" | "success" | "critical" }> = {
  pending: { label: "Chờ" },
  converting: { label: "Đang chuyển", tone: "attention" },
  done: { label: "Xong", tone: "success" },
  error: { label: "Lỗi", tone: "critical" },
};

export default function VideoConverterPage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [formatValue, setFormatValue] = useState("mp4");
  const [quality, setQuality] = useState<Quality>("balanced");
  const [resolution, setResolution] = useState<Resolution>("original");
  const [mute, setMute] = useState(false);
  const [preferRemux, setPreferRemux] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stageDetail, setStageDetail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);

  const urlsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);

  const format = FORMATS.find((f) => f.value === formatValue) ?? FORMATS[0];
  const isVideoOutput = format.kind === "video";

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

  const releaseResult = useCallback((item: QueueItem) => {
    if (!item.result) return;
    URL.revokeObjectURL(item.result.url);
    urlsRef.current.delete(item.result.url);
  }, []);

  const updateItem = useCallback((id: number, patch: Partial<QueueItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const handleDrop = useCallback((_all: File[], accepted: File[], rejectedFiles: File[]) => {
    const isVideo = (file: File) =>
      file.type.startsWith("video/") || /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|3gp|mpg|mpeg|ts|mts)$/i.test(file.name);
    const files = [...accepted, ...rejectedFiles];
    setRejected(files.filter((file) => !isVideo(file)).map((file) => file.name));
    setItems((prev) => [
      ...prev,
      ...files.filter(isVideo).map((file) => ({ id: nextItemId++, file, status: "pending" as const, progress: 0 })),
    ]);
  }, []);

  const removeItem = useCallback(
    (item: QueueItem) => {
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

  const settingsKey = [formatValue, quality, resolution, isVideoOutput && mute, preferRemux].join("|");
  const pendingCount = items.filter((item) => !isUpToDate(item, settingsKey)).length;
  const reconvertAll = pendingCount === 0 && items.length > 0;

  const handleConvert = useCallback(async () => {
    if (busyRef.current || items.length === 0) return;
    const settings: ConvertSettings = { format, quality, resolution, mute: isVideoOutput && mute };
    const runKey = settingsKey;
    const queue = reconvertAll ? items : items.filter((item) => !isUpToDate(item, settingsKey));

    // Converting again replaces any earlier output for these files.
    queue.forEach(releaseResult);
    setItems((prev) =>
      prev.map((item) =>
        queue.some((q) => q.id === item.id)
          ? { ...item, status: "pending", progress: 0, error: undefined, result: undefined }
          : item,
      ),
    );
    setNotice(null);
    setBusy(true);
    busyRef.current = true;
    cancelledRef.current = false;

    try {
      for (const [index, item] of queue.entries()) {
        if (!mountedRef.current || cancelledRef.current) return;
        // Fetched per file: if FFmpeg crashed on the previous file, this loads a fresh worker.
        const ffmpeg = await getFFmpeg(setStageDetail);
        setStageDetail(`Đang chuyển file ${index + 1}/${queue.length}: ${item.file.name}`);
        updateItem(item.id, { status: "converting", progress: 0 });

        const outputPath = `/converted-${item.id}.${settings.format.ext}`;
        try {
          const remuxed = await withInputFile(ffmpeg, item.file, async (inputPath) => {
            let duration: number | null = null;
            const run = (remux: boolean) =>
              execFFmpeg(ffmpeg, buildArgs(settings, inputPath, outputPath, remux), {
                onLog: (message) => {
                  duration ??= parseDurationLog(message);
                },
                onTime: (seconds) => {
                  if (duration) updateItem(item.id, { progress: Math.min(100, (seconds / duration) * 100) });
                },
              });

            if (preferRemux && canRemux(settings)) {
              try {
                await run(true);
                return true;
              } catch (error) {
                if (isTerminationError(error)) throw error;
                // The source codecs don't fit this container; fall through to a full re-encode.
              }
            }
            await run(false);
            return false;
          });

          const blob = await takeOutputFile(ffmpeg, outputPath, settings.format.mime);
          if (!mountedRef.current) return;
          const url = URL.createObjectURL(blob);
          urlsRef.current.add(url);
          updateItem(item.id, {
            status: "done",
            progress: 100,
            result: { url, name: outputName(item.file, settings.format), size: blob.size, remuxed, settingsKey: runKey },
          });
        } catch (error) {
          if (cancelledRef.current || isTerminationError(error)) throw error;
          console.error("[video-converter]", item.file.name, error);
          const noStream =
            error instanceof FFmpegExecError && error.logs.some((line) => /does not contain any stream/i.test(line));
          const message = noStream
            ? settings.format.kind === "audio"
              ? "File này không có track âm thanh."
              : "File này không có track video."
            : describeError(error);
          updateItem(item.id, { status: "error", progress: 0, error: message });
        }
      }
    } catch (error) {
      if (!mountedRef.current) return;
      if (cancelledRef.current || isTerminationError(error)) {
        setItems((prev) =>
          prev.map((item) => (item.status === "converting" ? { ...item, status: "pending", progress: 0 } : item)),
        );
        setNotice("Đã hủy. Các file đã chuyển xong vẫn được giữ lại.");
      } else {
        console.error("[video-converter]", error);
        setNotice(describeError(error, "Không tải được FFmpeg."));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setStageDetail("");
      }
    }
  }, [format, isVideoOutput, items, mute, preferRemux, quality, reconvertAll, releaseResult, resolution, settingsKey, updateItem]);

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

  const overallProgress =
    items.length === 0 ? 0 : items.reduce((sum, item) => sum + (item.status === "done" ? 100 : item.progress), 0) / items.length;

  return (
    <Page
      fullWidth
      backAction={{ content: "Tổng quan", url: "/" }}
      title="Chuyển đổi định dạng"
      subtitle="Đổi video sang MP4, MOV, MKV, WebM, AVI, GIF hoặc tách âm thanh MP3/M4A/WAV. Xử lý ngay trên trình duyệt, không tải lên máy chủ."
      primaryAction={{
        content: reconvertAll ? "Chuyển đổi lại" : pendingCount > 1 ? `Chuyển đổi ${pendingCount} file` : "Chuyển đổi",
        onAction: handleConvert,
        disabled: items.length === 0 || busy,
        loading: busy,
      }}
      secondaryActions={items.length > 0 ? [{ content: "Xóa tất cả", destructive: true, onAction: clearAll, disabled: busy }] : undefined}
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
                      item.status === "done" && !isUpToDate(item, settingsKey)
                        ? { label: "Cài đặt đã đổi", tone: "info" as const }
                        : STATUS_BADGE[item.status];
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
                              {formatBytes(item.file.size)}
                              {item.result &&
                                ` → ${item.result.name} · ${formatBytes(item.result.size)}${item.result.remuxed ? " · giữ nguyên codec" : ""}`}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="200" wrap={false}>
                            {item.result && (
                              <>
                                <Button url={item.result.url} external>
                                  Xem
                                </Button>
                                <Button url={item.result.url} download={item.result.name} variant="primary">
                                  Tải xuống
                                </Button>
                              </>
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
                        {item.status === "converting" && <ProgressBar progress={item.progress} size="small" tone="primary" />}
                        {item.error && (
                          <Text as="p" variant="bodySm" tone="critical">
                            {item.error}
                          </Text>
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
                  label="Chuyển sang"
                  options={FORMAT_OPTIONS}
                  value={formatValue}
                  onChange={setFormatValue}
                  disabled={busy}
                  helpText={format.hint}
                />
                {format.value !== "wav" && (
                  <Select
                    label="Chất lượng"
                    options={QUALITY_OPTIONS}
                    value={quality}
                    onChange={(value) => setQuality(value as Quality)}
                    disabled={busy}
                    helpText={format.kind === "gif" ? `Rộng tối đa ${GIF_WIDTH[quality]}px, ${GIF_FPS[quality]} khung hình/giây.` : undefined}
                  />
                )}
                {isVideoOutput && (
                  <>
                    <Select
                      label="Độ phân giải"
                      options={RESOLUTION_OPTIONS}
                      value={resolution}
                      onChange={(value) => setResolution(value as Resolution)}
                      disabled={busy}
                      helpText="Chỉ thu nhỏ, không phóng to video nhỏ hơn mức đã chọn."
                    />
                    <Checkbox label="Tắt tiếng (bỏ âm thanh)" checked={mute} onChange={setMute} disabled={busy} />
                    {format.remuxable && (
                      <Checkbox
                        label="Giữ nguyên codec nếu được"
                        helpText={
                          resolution === "original"
                            ? "Thử ghép lại sang định dạng mới mà không mã hóa lại: gần như tức thì và không giảm chất lượng. Tự động mã hóa lại nếu không được."
                            : "Không áp dụng khi đổi độ phân giải."
                        }
                        checked={preferRemux}
                        onChange={setPreferRemux}
                        disabled={busy || resolution !== "original"}
                      />
                    )}
                  </>
                )}
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
                  ) : items.length > 0 && doneItems.length === items.length ? (
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
                      : `${doneItems.length}/${items.length} file đã chuyển xong.`}
                  </Text>
                )}
                <Text as="p" variant="bodySm" tone="subdued">
                  Mã hóa lại diễn ra trên CPU của trình duyệt nên chậm hơn phần mềm cài trên máy, nhất là với video
                  1080p dài.
                </Text>
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
