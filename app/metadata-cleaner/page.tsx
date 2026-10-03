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
  Collapsible,
  Divider,
  DropZone,
  InlineStack,
  InlineGrid,
  Layout,
  List,
  Page,
  Select,
  Spinner,
  Text,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { formatBytes, triggerDownload } from "../_lib/format";
import {
  FFmpegCrashError,
  describeError,
  execFFmpeg,
  getFFmpeg,
  isTerminationError,
  probeMedia,
  takeOutputFile,
  withInputFile,
} from "../_lib/ffmpeg";
import { findEncoderSignatures, listMetadata, type MetadataEntry } from "../_lib/metadata";

type ItemStatus = "analyzing" | "ready" | "cleaning" | "done" | "error";
type Naming = "suffix" | "random";

interface CleanResult {
  url: string;
  name: string;
  size: number;
  after: MetadataEntry[];
  /** SEI units were stripped from the video bitstream. */
  deep: boolean;
  droppedSubtitles: boolean;
  settingsKey: string;
}

interface CleanItem {
  id: number;
  file: File;
  status: ItemStatus;
  error?: string;
  before?: MetadataEntry[];
  videoCodec?: string;
  result?: CleanResult;
  expanded: boolean;
}

// NAL unit types that carry SEI (encoder settings, camera info, user data) per codec.
const SEI_FILTERS: Record<string, string> = {
  h264: "filter_units=remove_types=6",
  hevc: "filter_units=remove_types=39|40",
};

const NAMING_OPTIONS = [
  { label: "Giữ tên gốc + “_clean”", value: "suffix" },
  { label: "Tên ngẫu nhiên (ẩn cả tên file gốc)", value: "random" },
];

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
};

const STATUS_BADGE: Record<ItemStatus, { label: string; tone?: "info" | "attention" | "success" | "critical" }> = {
  analyzing: { label: "Đang đọc metadata", tone: "info" },
  ready: { label: "Chờ làm sạch" },
  cleaning: { label: "Đang làm sạch", tone: "attention" },
  done: { label: "Đã làm sạch", tone: "success" },
  error: { label: "Lỗi", tone: "critical" },
};

let nextItemId = 1;

function fileExtension(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ? ext : "mp4";
}

function outputName(file: File, naming: Naming) {
  const ext = fileExtension(file.name);
  if (naming === "random") {
    const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
    return `video_${random}.${ext}`;
  }
  return `${file.name.replace(/\.[^.]+$/, "") || "video"}_clean.${ext}`;
}

// Encoder the audio is re-encoded with when requested, per output container. With bitexact
// set, these don't write the "Lavc<version>" string FFmpeg's AAC encoder normally embeds.
function audioReencodeArgs(ext: string) {
  return ext === "webm" ? ["-c:a", "libvorbis", "-q:a", "6"] : ["-c:a", "aac", "-b:a", "192k"];
}

function cleanArgs(
  input: string,
  output: string,
  { bsf, subtitles, audio }: { bsf?: string; subtitles: boolean; audio?: string[] },
) {
  return [
    "-i", input,
    // Keep only picture (not cover art) and sound, plus subtitles if wanted. Data tracks
    // (timed GPS, camera telemetry), attachments and thumbnails are dropped.
    "-map", "0:V?", "-map", "0:a?", ...(subtitles ? ["-map", "0:s?"] : []),
    // Drop global, per-stream and chapter metadata.
    "-map_metadata", "-1",
    "-map_metadata:s:v", "-1", "-map_metadata:s:a", "-1", "-map_metadata:s:s", "-1",
    "-map_chapters", "-1",
    // Stream copy: no re-encoding, so quality is untouched and it takes seconds.
    "-c", "copy",
    ...(audio ?? []),
    ...(bsf ? ["-bsf:v", bsf] : []),
    // Don't stamp FFmpeg's own version / creation time into the output.
    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    "-y", output,
  ];
}

const sensitiveCount = (entries: MetadataEntry[] = []) => entries.filter((entry) => entry.sensitive).length;

function MetadataList({ entries, emptyText }: { entries: MetadataEntry[]; emptyText: string }) {
  if (entries.length === 0) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        {emptyText}
      </Text>
    );
  }
  return (
    <BlockStack gap="100">
      {entries.map((entry, index) => (
        <InlineStack key={`${entry.scope}-${entry.key}-${index}`} gap="200" blockAlign="start" wrap={false}>
          <Box minWidth="88px">
            <Text as="span" variant="bodySm" tone="subdued">
              {entry.scope}
            </Text>
          </Box>
          <BlockStack gap="050">
            <InlineStack gap="150" blockAlign="center">
              <Text as="span" variant="bodySm" fontWeight="semibold">
                {entry.key}
              </Text>
              {entry.sensitive ? <Badge tone="critical" size="small">Nhạy cảm</Badge> : <Badge size="small">Cấu trúc</Badge>}
            </InlineStack>
            <Text as="span" variant="bodySm" breakWord>
              {entry.value}
            </Text>
          </BlockStack>
        </InlineStack>
      ))}
    </BlockStack>
  );
}

export default function MetadataCleanerPage() {
  const [items, setItems] = useState<CleanItem[]>([]);
  const [deepClean, setDeepClean] = useState(true);
  const [keepSubtitles, setKeepSubtitles] = useState(true);
  const [reencodeAudio, setReencodeAudio] = useState(false);
  const [naming, setNaming] = useState<Naming>("suffix");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);

  const urlsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  // FFmpeg work (analysis and cleaning) runs strictly one task at a time.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  const settingsKey = [deepClean, keepSubtitles, reencodeAudio, naming].join("|");

  useEffect(() => {
    mountedRef.current = true;
    const urls = urlsRef.current;
    return () => {
      mountedRef.current = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  const enqueue = useCallback(<T,>(task: () => Promise<T>) => {
    const run = chainRef.current.then(task, task);
    chainRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const updateItem = useCallback((id: number, patch: Partial<CleanItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const releaseResult = useCallback((item: CleanItem) => {
    if (!item.result) return;
    URL.revokeObjectURL(item.result.url);
    urlsRef.current.delete(item.result.url);
  }, []);

  const analyze = useCallback(
    (item: CleanItem) =>
      enqueue(async () => {
        try {
          const ffmpeg = await getFFmpeg();
          const probe = await withInputFile(ffmpeg, item.file, (inputPath) => probeMedia(ffmpeg, inputPath));
          const signatures = await findEncoderSignatures(item.file);
          const videoCodec = probe.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic)?.codec_name;
          if (!mountedRef.current) return;
          updateItem(item.id, { status: "ready", before: [...listMetadata(probe), ...signatures], videoCodec });
        } catch (error) {
          console.error("[metadata-cleaner] analyze", item.file.name, error);
          if (mountedRef.current) {
            updateItem(item.id, { status: "error", error: `Không đọc được file: ${describeError(error)}` });
          }
        }
      }),
    [enqueue, updateItem],
  );

  const handleDrop = useCallback(
    (_all: File[], accepted: File[], rejectedFiles: File[]) => {
      const isVideo = (file: File) => file.type.startsWith("video/") || /\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(file.name);
      const files = [...accepted, ...rejectedFiles];
      setRejected(files.filter((file) => !isVideo(file)).map((file) => file.name));
      const added: CleanItem[] = files
        .filter(isVideo)
        .map((file) => ({ id: nextItemId++, file, status: "analyzing", expanded: false }));
      setItems((prev) => [...prev, ...added]);
      added.forEach((item) => void analyze(item));
    },
    [analyze],
  );

  const removeItem = useCallback(
    (item: CleanItem) => {
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

  const isUpToDate = (item: CleanItem) => item.status === "done" && item.result?.settingsKey === settingsKey;
  const analyzing = items.some((item) => item.status === "analyzing");
  // Anything analysed that has no up-to-date result: new files, failed cleans, or results made with other settings.
  const pending = items.filter(
    (item) => (item.status === "ready" || item.status === "done" || (item.status === "error" && item.before)) && !isUpToDate(item),
  );
  const reclean = pending.length === 0 && items.some((item) => item.status === "done");

  const handleClean = useCallback(async () => {
    const queue = reclean ? items.filter((item) => item.status === "done") : pending;
    if (busy || queue.length === 0) return;
    const options = { deepClean, keepSubtitles, reencodeAudio, naming, settingsKey };
    queue.forEach(releaseResult);
    setItems((prev) =>
      prev.map((item) => (queue.some((q) => q.id === item.id) ? { ...item, status: "cleaning", result: undefined, error: undefined } : item)),
    );
    setBusy(true);
    setNotice(null);

    let cleaned = 0;
    for (const item of queue) {
      await enqueue(async () => {
        const ext = fileExtension(item.file.name);
        const outputPath = `/clean-${item.id}.${ext}`;
        try {
          const ffmpeg = await getFFmpeg();
          const seiFilter = options.deepClean && item.videoCodec ? SEI_FILTERS[item.videoCodec] : undefined;
          // Most aggressive first; relax only if the container/codec refuses.
          const attempts = [
            { bsf: seiFilter, subtitles: options.keepSubtitles },
            ...(seiFilter ? [{ bsf: undefined, subtitles: options.keepSubtitles }] : []),
            ...(options.keepSubtitles ? [{ bsf: undefined, subtitles: false }] : []),
          ];
          const used = await withInputFile(ffmpeg, item.file, async (inputPath) => {
            let lastError: unknown;
            for (const attempt of attempts) {
              try {
                const audio = options.reencodeAudio ? audioReencodeArgs(ext) : undefined;
                await execFFmpeg(ffmpeg, cleanArgs(inputPath, outputPath, { ...attempt, audio }));
                return attempt;
              } catch (error) {
                if (isTerminationError(error)) throw error;
                lastError = error;
                // After a crash the worker is gone, so further attempts here would fail too.
                if (error instanceof FFmpegCrashError) throw error;
              }
            }
            throw lastError;
          });

          const after = listMetadata(await probeMedia(ffmpeg, outputPath));
          const blob = await takeOutputFile(ffmpeg, outputPath, MIME_BY_EXT[ext]);
          const afterAll = [...after, ...(await findEncoderSignatures(blob))];
          if (!mountedRef.current) return;
          const url = URL.createObjectURL(blob);
          urlsRef.current.add(url);
          cleaned++;
          updateItem(item.id, {
            status: "done",
            result: {
              url,
              name: outputName(item.file, options.naming),
              size: blob.size,
              after: afterAll,
              deep: Boolean(used.bsf),
              droppedSubtitles: options.keepSubtitles && !used.subtitles,
              settingsKey: options.settingsKey,
            },
          });
        } catch (error) {
          console.error("[metadata-cleaner] clean", item.file.name, error);
          if (mountedRef.current) updateItem(item.id, { status: "error", error: describeError(error) });
        }
      });
    }
    if (!mountedRef.current) return;
    setBusy(false);
    setNotice(`Đã làm sạch ${cleaned}/${queue.length} file.`);
  }, [busy, deepClean, enqueue, items, keepSubtitles, naming, pending, reclean, reencodeAudio, releaseResult, settingsKey, updateItem]);

  const doneItems = items.filter((item) => item.result);

  const handleDownloadAll = useCallback(async () => {
    for (const item of doneItems) {
      triggerDownload(item.result!.url, item.result!.name);
      // Browsers throttle bursts of downloads; space them out slightly.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }, [doneItems]);

  const primaryCount = reclean ? doneItems.length : pending.length;

  return (
    <Page
      fullWidth
      backAction={{ content: "Tổng quan", url: "/" }}
      title="Làm sạch metadata"
      subtitle="Xóa toàn bộ siêu dữ liệu (vị trí GPS, thiết bị, ngày quay, phần mềm…) khỏi video mà không mã hóa lại. Xử lý ngay trên trình duyệt."
      primaryAction={{
        content: reclean ? "Làm sạch lại" : primaryCount > 1 ? `Làm sạch ${primaryCount} file` : "Làm sạch",
        onAction: handleClean,
        disabled: primaryCount === 0 || busy || analyzing,
        loading: busy,
      }}
      secondaryActions={items.length > 0 ? [{ content: "Xóa tất cả", destructive: true, onAction: clearAll, disabled: busy || analyzing }] : undefined}
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
                  <DropZone.FileUpload actionTitle="Chọn video" actionHint="Có thể chọn nhiều file: MP4, MOV, MKV, WebM, AVI" />
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
                      Thêm video để xem metadata đang có trong file.
                    </Text>
                  </Box>
                ) : (
                  items.map((item, index) => {
                    const badge =
                      item.status === "done" && !isUpToDate(item)
                        ? { label: "Cài đặt đã đổi", tone: "info" as const }
                        : STATUS_BADGE[item.status];
                    const before = item.before ?? [];
                    const after = item.result?.after ?? [];
                    const remainingSensitive = sensitiveCount(after);
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
                              {(item.status === "analyzing" || item.status === "cleaning") && (
                                <Spinner size="small" accessibilityLabel={badge.label} />
                              )}
                            </InlineStack>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {formatBytes(item.file.size)}
                              {item.before &&
                                ` · Trước: ${before.length} trường, ${sensitiveCount(before)} nhạy cảm`}
                              {item.result &&
                                ` → Sau: ${after.length} trường, ${remainingSensitive} nhạy cảm · ${item.result.name} (${formatBytes(item.result.size)})`}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="200" wrap={false}>
                            {item.before && (
                              <Button
                                variant="plain"
                                onClick={() => updateItem(item.id, { expanded: !item.expanded })}
                                ariaExpanded={item.expanded}
                              >
                                {item.expanded ? "Ẩn chi tiết" : "Xem chi tiết"}
                              </Button>
                            )}
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
                              disabled={busy || item.status === "analyzing"}
                            />
                          </InlineStack>
                        </InlineStack>

                        {item.error && (
                          <Text as="p" variant="bodySm" tone="critical">
                            {item.error}
                          </Text>
                        )}
                        {item.result && !reencodeAudio && item.result.after.some((entry) => entry.key.includes("Lavc")) && (
                          <Text as="p" variant="bodySm" tone="caution">
                            Vẫn còn dấu vết phiên bản phần mềm trong luồng âm thanh/hình. Bật “Mã hóa lại âm thanh” rồi
                            làm sạch lại để xóa.
                          </Text>
                        )}
                        {item.result && (item.result.droppedSubtitles || (deepClean && !item.result.deep && item.videoCodec && SEI_FILTERS[item.videoCodec])) && (
                          <Text as="p" variant="bodySm" tone="caution">
                            {item.result.droppedSubtitles ? "Track phụ đề không chép được sang file mới nên đã bị bỏ. " : ""}
                            {deepClean && !item.result.deep && item.videoCodec && SEI_FILTERS[item.videoCodec]
                              ? "Không xóa được SEI trong luồng video với file này; metadata của file vẫn đã được xóa."
                              : ""}
                          </Text>
                        )}

                        <Collapsible id={`meta-${item.id}`} open={item.expanded}>
                          <Box paddingBlockStart="200">
                            <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                                <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                                  <BlockStack gap="200">
                                    <Text as="h3" variant="headingSm">
                                      Trước khi làm sạch
                                    </Text>
                                    <MetadataList entries={before} emptyText="Không tìm thấy metadata." />
                                  </BlockStack>
                                </Box>

                                <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                                  <BlockStack gap="200">
                                    <Text as="h3" variant="headingSm">
                                      Sau khi làm sạch
                                    </Text>
                                    {item.result ? (
                                      <>
                                        {remainingSensitive === 0 && (
                                          <Badge tone="success">Không còn metadata nhận dạng</Badge>
                                        )}
                                        <MetadataList entries={after} emptyText="Không còn metadata nào." />
                                      </>
                                    ) : (
                                      <Text as="p" variant="bodySm" tone="subdued">
                                        Chưa làm sạch.
                                      </Text>
                                    )}
                                  </BlockStack>
                                </Box>
                            </InlineGrid>
                          </Box>
                        </Collapsible>
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
                  Tùy chọn
                </Text>
                <Checkbox
                  label="Làm sạch sâu (xóa SEI trong luồng video)"
                  helpText="Xóa cả thông tin bộ mã hóa và dữ liệu người dùng giấu trong luồng H.264/HEVC. Với video HDR của iPhone, màu HDR có thể hiển thị kém hơn – bỏ chọn nếu cần giữ HDR."
                  checked={deepClean}
                  onChange={setDeepClean}
                  disabled={busy}
                />
                <Checkbox
                  label="Mã hóa lại âm thanh"
                  helpText="Xóa dấu vết phiên bản phần mềm (vd. “Lavc59…”) nằm trong chính luồng âm thanh của video đã qua FFmpeg/CapCut… Hình vẫn giữ nguyên; tiếng được mã hóa lại AAC 192 kbps nên giảm rất nhẹ."
                  checked={reencodeAudio}
                  onChange={setReencodeAudio}
                  disabled={busy}
                />
                <Checkbox
                  label="Giữ track phụ đề nhúng"
                  helpText="Phụ đề là nội dung, không phải metadata. Bỏ chọn để chỉ giữ hình và tiếng."
                  checked={keepSubtitles}
                  onChange={setKeepSubtitles}
                  disabled={busy}
                />
                <Select label="Tên file đầu ra" options={NAMING_OPTIONS} value={naming} onChange={(v) => setNaming(v as Naming)} disabled={busy} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Những gì sẽ bị xóa
                </Text>
                <List type="bullet">
                  <List.Item>Vị trí GPS / tọa độ nơi quay</List.Item>
                  <List.Item>Hãng, model thiết bị, phần mềm quay/chỉnh sửa</List.Item>
                  <List.Item>Ngày giờ tạo, tiêu đề, mô tả, tác giả, bản quyền</List.Item>
                  <List.Item>Chương (chapter), ảnh bìa/thumbnail nhúng</List.Item>
                  <List.Item>Track dữ liệu phụ (GPS theo thời gian, thông số máy quay)</List.Item>
                  <List.Item>Chuỗi thông tin bộ mã hóa trong luồng video (khi bật làm sạch sâu)</List.Item>
                  <List.Item>Dấu vết phần mềm trong luồng âm thanh (khi bật mã hóa lại âm thanh)</List.Item>
                </List>
                <Text as="p" variant="bodySm" tone="subdued">
                  Hình và tiếng được giữ nguyên 100% (không mã hóa lại), trừ khi bật mã hóa lại âm thanh. Các trường “Cấu trúc” còn lại như loại
                  container hay ngôn ngữ “und” là bắt buộc và không chứa thông tin cá nhân. Công cụ không xóa được
                  thông tin nằm trong chính hình ảnh/âm thanh (logo, watermark, giọng nói).
                </Text>
              </BlockStack>
            </Card>

            {notice && (
              <Banner tone="success" onDismiss={() => setNotice(null)}>
                <p>{notice}</p>
              </Banner>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
