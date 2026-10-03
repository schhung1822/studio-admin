"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
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
  Tooltip,
} from "@shopify/polaris";
import { ClockIcon, DeleteIcon, PlayIcon, PlusIcon } from "@shopify/polaris-icons";
import { formatBytes, formatTimecode, parseTimecode, triggerDownload } from "../_lib/format";
import { describeError, execFFmpeg, getFFmpeg, isTerminationError, takeOutputFile, terminateFFmpeg, withInputFile } from "../_lib/ffmpeg";

type CutMode = "copy" | "reencode";
type QuickSplitMode = "length" | "count";
type Status = "idle" | "processing" | "completed" | "error";

interface Segment {
  id: number;
  start: string;
  end: string;
}

interface SegmentResult {
  id: number;
  name: string;
  url: string;
  size: number;
  start: number;
  end: number;
  /** Seconds of extra footage before `start`, when a stream-copy cut snapped to an earlier keyframe. */
  leadIn: number;
}

const CUT_MODE_OPTIONS = [
  { label: "Nhanh – giữ nguyên chất lượng", value: "copy" },
  { label: "Chính xác từng khung hình (mã hóa lại)", value: "reencode" },
];

const QUICK_SPLIT_OPTIONS = [
  { label: "Theo độ dài mỗi đoạn", value: "length" },
  { label: "Theo số phần bằng nhau", value: "count" },
];

// Containers that can take the original streams unchanged in "copy" mode.
const CONTAINER_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

// Segments shorter than this at the end of a quick split are merged into the previous one.
const MIN_TAIL_SECONDS = 1;

// Stream-copy cuts that start more than this much earlier than requested get a warning.
const LEAD_IN_WARNING_SECONDS = 0.5;

/** Reads a playable blob's duration through a detached <video> element. */
function measureDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const done = (value: number | null) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 5000);
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

let nextSegmentId = 1;
const newSegment = (start: number, end: number): Segment => ({
  id: nextSegmentId++,
  start: formatTimecode(start),
  end: formatTimecode(end),
});

function validateSegment(segment: Segment, duration: number | null) {
  const start = parseTimecode(segment.start);
  const end = parseTimecode(segment.end);
  const errors: { start?: string; end?: string } = {};
  if (start === null) errors.start = "Sai định dạng (vd: 01:30)";
  if (end === null) errors.end = "Sai định dạng (vd: 02:45.5)";
  if (start !== null && end !== null && end <= start) errors.end = "Phải sau thời điểm bắt đầu";
  if (duration !== null) {
    if (start !== null && start >= duration) errors.start = "Vượt quá thời lượng video";
    if (end !== null && end > duration + 0.05) errors.end = `Tối đa ${formatTimecode(duration)}`;
  }
  const valid = !errors.start && !errors.end && start !== null && end !== null;
  return { start, end: end !== null && duration !== null ? Math.min(end, duration) : end, errors, valid };
}

export default function VideoSplitterPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [metadataError, setMetadataError] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [cutMode, setCutMode] = useState<CutMode>("copy");
  const [quickMode, setQuickMode] = useState<QuickSplitMode>("length");
  const [quickValue, setQuickValue] = useState("01:00");
  const [status, setStatus] = useState<Status>("idle");
  const [stageDetail, setStageDetail] = useState("");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<SegmentResult[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewEndRef = useRef<number | null>(null);
  const resultUrlsRef = useRef<string[]>([]);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);

  const busy = status === "processing";

  const validated = useMemo(() => segments.map((segment) => validateSegment(segment, duration)), [segments, duration]);
  const allValid = segments.length > 0 && validated.every((v) => v.valid);
  const totalSelected = validated.reduce((sum, v) => (v.valid ? sum + (v.end! - v.start!) : sum), 0);

  const clearResults = useCallback(() => {
    resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    resultUrlsRef.current = [];
    setResults([]);
  }, []);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (busyRef.current) terminateFFmpeg();
      resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      resultUrlsRef.current = [];
    };
  }, []);

  const resetForNewFile = useCallback(() => {
    clearResults();
    setSegments([]);
    setDuration(null);
    setMetadataError(false);
    setStatus("idle");
    setProgress(0);
    setStageDetail("");
    setErrorMessage(null);
    setNotice(null);
  }, [clearResults]);

  const handleDrop = useCallback(
    (_all: File[], accepted: File[], rejected: File[]) => {
      const next = accepted[0] ?? rejected[0];
      if (!next) return;
      resetForNewFile();
      if (!next.type.startsWith("video/") && !/\.(mp4|m4v|mov|webm|mkv)$/i.test(next.name)) {
        setFile(null);
        setPreviewUrl(null);
        setStatus("error");
        setErrorMessage(`"${next.name}" không phải file video.`);
        return;
      }
      setFile(next);
      setPreviewUrl(URL.createObjectURL(next));
    },
    [resetForNewFile],
  );

  const clearFile = useCallback(() => {
    resetForNewFile();
    setFile(null);
    setPreviewUrl(null);
  }, [resetForNewFile]);

  const updateSegment = useCallback((id: number, patch: Partial<Segment>) => {
    setSegments((prev) => prev.map((segment) => (segment.id === id ? { ...segment, ...patch } : segment)));
  }, []);

  const currentTime = () => videoRef.current?.currentTime ?? 0;

  const addSegment = useCallback(() => {
    if (duration === null) return;
    setSegments((prev) => {
      const last = prev.length > 0 ? parseTimecode(prev[prev.length - 1].end) : null;
      const start = Math.min(last ?? videoRef.current?.currentTime ?? 0, Math.max(0, duration - 1));
      return [...prev, newSegment(start, Math.min(start + 60, duration))];
    });
  }, [duration]);

  const applyQuickSplit = useCallback(() => {
    if (duration === null) return;
    let length: number | null;
    if (quickMode === "count") {
      const count = Number.parseInt(quickValue, 10);
      length = Number.isFinite(count) && count >= 1 ? duration / count : null;
    } else {
      length = parseTimecode(quickValue);
    }
    if (!length || length <= 0) {
      setErrorMessage(quickMode === "count" ? "Số phần phải là số nguyên ≥ 1." : "Độ dài đoạn không hợp lệ (vd: 01:00).");
      return;
    }
    const generated: Segment[] = [];
    for (let start = 0; start < duration - 0.001; start += length) {
      const end = Math.min(start + length, duration);
      if (generated.length > 0 && end - start < MIN_TAIL_SECONDS) {
        generated[generated.length - 1].end = formatTimecode(end);
        break;
      }
      generated.push(newSegment(Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000));
    }
    setErrorMessage(null);
    setSegments(generated);
  }, [duration, quickMode, quickValue]);

  const previewSegment = useCallback((start: number, end: number) => {
    const video = videoRef.current;
    if (!video) return;
    previewEndRef.current = end;
    video.currentTime = start;
    void video.play();
  }, []);

  const handleSplit = useCallback(async () => {
    if (!file || busyRef.current || !allValid) return;
    const jobs = validated.map((v) => ({ start: v.start!, end: v.end! }));

    clearResults();
    setErrorMessage(null);
    setNotice(null);
    setProgress(0);
    setStatus("processing");
    busyRef.current = true;
    cancelledRef.current = false;

    const inputExt = file.name.split(".").pop()?.toLowerCase() ?? "";
    const ext = cutMode === "copy" && CONTAINER_MIME[inputExt] ? inputExt : "mp4";
    const mime = CONTAINER_MIME[ext];
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const digits = Math.max(2, String(jobs.length).length);

    try {
      const ffmpeg = await getFFmpeg(setStageDetail);
      await withInputFile(ffmpeg, file, async (inputPath) => {
        for (const [index, job] of jobs.entries()) {
          const length = job.end - job.start;
          const outputPath = `/segment-${index}.${ext}`;
          setStageDetail(`Đang cắt đoạn ${index + 1}/${jobs.length}…`);

          // -ss before -i seeks quickly. With stream copy the cut snaps to the nearest
          // keyframe; re-encoding makes it frame-accurate at the cost of speed.
          const codecArgs =
            cutMode === "copy"
              ? ["-c", "copy", "-avoid_negative_ts", "make_zero"]
              : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"];
          await execFFmpeg(
            ffmpeg,
            [
              "-ss", job.start.toFixed(3),
              "-i", inputPath,
              "-t", length.toFixed(3),
              "-map", "0:v:0?",
              "-map", "0:a?",
              ...codecArgs,
              "-y", outputPath,
            ],
            {
              onTime: (seconds) => {
                const part = Math.min(1, Math.max(0, seconds / length));
                setProgress(((index + part) / jobs.length) * 100);
              },
            },
          );

          const blob = await takeOutputFile(ffmpeg, outputPath, mime);
          if (!mountedRef.current) return;
          const url = URL.createObjectURL(blob);
          resultUrlsRef.current.push(url);
          const measured = cutMode === "copy" ? await measureDuration(url) : null;
          const result: SegmentResult = {
            id: index,
            name: `${baseName}_part${String(index + 1).padStart(digits, "0")}.${ext}`,
            url,
            size: blob.size,
            start: job.start,
            end: job.end,
            leadIn: measured === null ? 0 : Math.max(0, measured - length),
          };
          setResults((prev) => [...prev, result]);
        }
      });
      if (!mountedRef.current) return;
      setProgress(100);
      setStageDetail("");
      setStatus("completed");
    } catch (error) {
      if (!mountedRef.current) return;
      setStageDetail("");
      if (cancelledRef.current || isTerminationError(error)) {
        setStatus("idle");
        setNotice("Đã hủy. Các đoạn đã cắt xong vẫn được giữ lại bên dưới.");
        return;
      }
      console.error("[video-splitter]", error);
      setStatus("error");
      setErrorMessage(describeError(error, "Đã có lỗi xảy ra khi cắt video."));
    } finally {
      busyRef.current = false;
    }
  }, [allValid, clearResults, cutMode, file, validated]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    terminateFFmpeg();
  }, []);

  const handleDownloadAll = useCallback(async () => {
    for (const result of results) {
      triggerDownload(result.url, result.name);
      // Browsers throttle bursts of downloads; space them out slightly.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }, [results]);

  const statusBadge =
    status === "processing" ? (
      <Badge tone="attention">Đang cắt</Badge>
    ) : status === "completed" ? (
      <Badge tone="success">Hoàn tất</Badge>
    ) : status === "error" ? (
      <Badge tone="critical">Lỗi</Badge>
    ) : (
      <Badge>Sẵn sàng</Badge>
    );

  return (
    <Page
      fullWidth
      backAction={{ content: "Tổng quan", url: "/" }}
      title="Cắt video"
      subtitle="Chia video thành nhiều đoạn theo mốc thời gian bạn chọn. Mọi xử lý diễn ra ngay trên trình duyệt, không tải video lên máy chủ."
      primaryAction={{
        content: segments.length > 1 ? `Cắt ${segments.length} đoạn` : "Cắt video",
        onAction: handleSplit,
        disabled: !file || !allValid || busy,
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
                {!file ? (
                  <DropZone accept="video/*" type="file" allowMultiple={false} onDrop={handleDrop} label="Video" labelHidden>
                    <DropZone.FileUpload actionTitle="Chọn video" actionHint="MP4, MOV, WebM, MKV" />
                  </DropZone>
                ) : (
                  <>
                    <InlineStack align="space-between" blockAlign="center" gap="200">
                      <BlockStack>
                        <Text as="p" variant="bodyMd" fontWeight="semibold" breakWord>
                          {file.name}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {formatBytes(file.size)}
                          {duration !== null && ` · ${formatTimecode(duration, { fractional: false })}`}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                    {previewUrl && (
                      <video
                        ref={videoRef}
                        src={previewUrl}
                        controls
                        preload="metadata"
                        style={{ width: "100%", maxHeight: 420, borderRadius: "var(--p-border-radius-200)", background: "#000" }}
                        onLoadedMetadata={(event) => {
                          const seconds = event.currentTarget.duration;
                          if (Number.isFinite(seconds)) setDuration(seconds);
                          else setMetadataError(true);
                        }}
                        onError={() => setMetadataError(true)}
                        onTimeUpdate={(event) => {
                          const stopAt = previewEndRef.current;
                          if (stopAt !== null && event.currentTarget.currentTime >= stopAt) {
                            event.currentTarget.pause();
                            previewEndRef.current = null;
                          }
                        }}
                        onSeeking={(event) => {
                          // A manual seek outside the previewed segment cancels the auto-stop.
                          const stopAt = previewEndRef.current;
                          if (stopAt !== null && event.currentTarget.currentTime > stopAt) previewEndRef.current = null;
                        }}
                      />
                    )}
                    {metadataError && (
                      <Banner tone="critical" title="Trình duyệt không đọc được video này">
                        <p>Không lấy được thời lượng video. Hãy thử chuyển sang MP4 (H.264) hoặc WebM.</p>
                      </Banner>
                    )}
                  </>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Các đoạn cần cắt
                    </Text>
                    <Button icon={PlusIcon} onClick={addSegment} disabled={duration === null || busy}>
                      Thêm đoạn
                    </Button>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Nhập thời gian dạng phút:giây (01:30) hoặc giờ:phút:giây (1:02:30.5). Bấm biểu tượng đồng hồ để lấy thời
                    điểm đang phát trên video.
                  </Text>
                </BlockStack>

                {segments.length === 0 ? (
                  <Box paddingBlock="400">
                    <Text as="p" tone="subdued" alignment="center">
                      {file
                        ? "Chưa có đoạn nào. Bấm “Thêm đoạn” hoặc dùng “Chia nhanh” ở cột bên phải."
                        : "Tải video lên để bắt đầu."}
                    </Text>
                  </Box>
                ) : (
                  <BlockStack gap="300">
                    {segments.map((segment, index) => {
                      const check = validated[index];
                      return (
                        <BlockStack key={segment.id} gap="300">
                          {index > 0 && <Divider />}
                          <InlineGrid columns={{ xs: "1fr", md: "32px 1fr 1fr auto" }} gap="300" alignItems="start">
                            <Box paddingBlockStart={{ xs: "0", md: "200" }}>
                              <Text as="span" fontWeight="semibold" tone="subdued">
                                #{index + 1}
                              </Text>
                            </Box>
                            <TextField
                              label="Bắt đầu"
                              labelHidden
                              prefix="Từ"
                              value={segment.start}
                              onChange={(value) => updateSegment(segment.id, { start: value })}
                              error={check.errors.start}
                              autoComplete="off"
                              disabled={busy}
                              connectedRight={
                                <Tooltip content="Lấy thời điểm đang phát">
                                  <Button
                                    icon={ClockIcon}
                                    accessibilityLabel="Đặt thời điểm bắt đầu bằng thời điểm đang phát"
                                    onClick={() => updateSegment(segment.id, { start: formatTimecode(currentTime()) })}
                                    disabled={busy}
                                  />
                                </Tooltip>
                              }
                            />
                            <TextField
                              label="Kết thúc"
                              labelHidden
                              prefix="Đến"
                              value={segment.end}
                              onChange={(value) => updateSegment(segment.id, { end: value })}
                              error={check.errors.end}
                              autoComplete="off"
                              disabled={busy}
                              connectedRight={
                                <Tooltip content="Lấy thời điểm đang phát">
                                  <Button
                                    icon={ClockIcon}
                                    accessibilityLabel="Đặt thời điểm kết thúc bằng thời điểm đang phát"
                                    onClick={() => updateSegment(segment.id, { end: formatTimecode(currentTime()) })}
                                    disabled={busy}
                                  />
                                </Tooltip>
                              }
                            />
                            <InlineStack gap="100" blockAlign="center" wrap={false}>
                              <Box minWidth="64px">
                                <Text as="span" variant="bodySm" tone="subdued" alignment="end">
                                  {check.valid ? formatTimecode(check.end! - check.start!, { fractional: false }) : "--:--"}
                                </Text>
                              </Box>
                              <Tooltip content="Xem thử đoạn này">
                                <Button
                                  icon={PlayIcon}
                                  variant="tertiary"
                                  accessibilityLabel={`Xem thử đoạn ${index + 1}`}
                                  onClick={() => previewSegment(check.start!, check.end!)}
                                  disabled={!check.valid}
                                />
                              </Tooltip>
                              <Tooltip content="Xóa đoạn">
                                <Button
                                  icon={DeleteIcon}
                                  variant="tertiary"
                                  tone="critical"
                                  accessibilityLabel={`Xóa đoạn ${index + 1}`}
                                  onClick={() => setSegments((prev) => prev.filter((s) => s.id !== segment.id))}
                                  disabled={busy}
                                />
                              </Tooltip>
                            </InlineStack>
                          </InlineGrid>
                        </BlockStack>
                      );
                    })}
                    <Divider />
                    <InlineStack align="space-between">
                      <Text as="p" variant="bodySm" tone="subdued">
                        {segments.length} đoạn · tổng {formatTimecode(totalSelected, { fractional: false })}
                      </Text>
                      <Button variant="plain" tone="critical" onClick={() => setSegments([])} disabled={busy}>
                        Xóa tất cả
                      </Button>
                    </InlineStack>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {results.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Kết quả ({results.length})
                    </Text>
                    <Button onClick={handleDownloadAll} disabled={busy}>
                      Tải tất cả
                    </Button>
                  </InlineStack>
                  {results.some((result) => result.leadIn > LEAD_IN_WARNING_SECONDS) && (
                    <Banner tone="warning">
                      <p>
                        Video này có ít keyframe nên ở chế độ Nhanh, một số đoạn bắt đầu sớm hơn mốc đã chọn. Chuyển sang
                        chế độ “Chính xác từng khung hình” rồi cắt lại nếu cần đúng mốc.
                      </p>
                    </Banner>
                  )}
                  {results.map((result, index) => (
                    <BlockStack key={result.id} gap="300">
                      {index > 0 && <Divider />}
                      <InlineStack align="space-between" blockAlign="center" gap="200">
                        <BlockStack>
                          <Text as="p" fontWeight="semibold" breakWord>
                            {result.name}
                          </Text>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="p" variant="bodySm" tone="subdued">
                              {formatTimecode(result.start)} → {formatTimecode(result.end)} · {formatBytes(result.size)}
                            </Text>
                            {result.leadIn > LEAD_IN_WARNING_SECONDS && (
                              <Badge tone="warning">{`Bắt đầu sớm hơn ~${result.leadIn.toFixed(1)}s`}</Badge>
                            )}
                          </InlineStack>
                        </BlockStack>
                        <InlineStack gap="200">
                          <Button url={result.url} external>
                            Xem
                          </Button>
                          <Button url={result.url} download={result.name}>
                            Tải xuống
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    </BlockStack>
                  ))}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Cài đặt cắt
                </Text>
                <Select
                  label="Chế độ"
                  options={CUT_MODE_OPTIONS}
                  value={cutMode}
                  onChange={(value) => setCutMode(value as CutMode)}
                  disabled={busy}
                  helpText={
                    cutMode === "copy"
                      ? "Rất nhanh, không giảm chất lượng. Mỗi đoạn phải bắt đầu từ keyframe gần nhất phía trước, nên có thể bắt đầu sớm hơn mốc đã chọn (app sẽ cảnh báo nếu bị lệch)."
                      : "Cắt chính xác tới từng khung hình nhưng chậm hơn nhiều (mã hóa lại H.264). Phù hợp với đoạn ngắn."
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Chia nhanh
                </Text>
                <Select
                  label="Cách chia"
                  options={QUICK_SPLIT_OPTIONS}
                  value={quickMode}
                  onChange={(value) => {
                    setQuickMode(value as QuickSplitMode);
                    setQuickValue(value === "count" ? "3" : "01:00");
                  }}
                  disabled={busy}
                />
                <TextField
                  label={quickMode === "count" ? "Số phần" : "Độ dài mỗi đoạn"}
                  type={quickMode === "count" ? "number" : "text"}
                  min={quickMode === "count" ? 1 : undefined}
                  value={quickValue}
                  onChange={setQuickValue}
                  autoComplete="off"
                  disabled={busy}
                  helpText={quickMode === "length" ? "Ví dụ: 00:30, 05:00, 1:00:00" : undefined}
                />
                <Button onClick={applyQuickSplit} disabled={duration === null || busy}>
                  Tạo các đoạn
                </Button>
                <Text as="p" variant="bodySm" tone="subdued">
                  Danh sách đoạn hiện tại sẽ được thay thế. Bạn vẫn chỉnh sửa từng đoạn sau đó.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Trạng thái
                  </Text>
                  {statusBadge}
                </InlineStack>

                {busy ? (
                  <BlockStack gap="200">
                    <ProgressBar progress={progress} size="small" tone="primary" />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {stageDetail} {progress > 0 && `${Math.round(progress)}%`}
                    </Text>
                    <InlineStack align="end">
                      <Button tone="critical" variant="plain" onClick={handleCancel}>
                        Hủy
                      </Button>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {status === "completed"
                      ? `Đã cắt xong ${results.length} đoạn.`
                      : !file
                        ? "Tải video lên để bắt đầu."
                        : segments.length === 0
                          ? "Thêm ít nhất một đoạn để cắt."
                          : allValid
                            ? "Sẵn sàng. Bấm nút Cắt ở đầu trang."
                            : "Có đoạn chưa hợp lệ, hãy kiểm tra lại thời gian."}
                  </Text>
                )}

                {notice && (
                  <Banner tone="info" onDismiss={() => setNotice(null)}>
                    <p>{notice}</p>
                  </Banner>
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
