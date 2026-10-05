"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DropZone,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  RangeSlider,
  Select,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { formatBytes, formatTimecode } from "../_lib/format";
import { describeError, isTerminationError, terminateFFmpeg } from "../_lib/ffmpeg";
import {
  MAX_SPEECH_SECONDS,
  SPEECH_LANGUAGE_OPTIONS,
  extractSpeechAudio,
  requestTranscription,
  speechLanguageHelpText,
  type TranscribeResponse,
} from "../_lib/speech";
import { captureFrames } from "../_lib/frames";
import { approximateWords, buildScenes, wordJoinerFor, type SceneSpan } from "../_lib/scenes";
import { distributeToScenes, joinerForText, parseSubtitleFile, timeImportedWords } from "../_lib/subtitle-file";
import { canPickDirectory, downloadAsZip, isUserCancel, saveToPickedDirectory, type ExportFile } from "../_lib/export-folder";

type Status = "idle" | "extracting" | "transcribing" | "capturing" | "completed" | "error";
type FramePosition = "middle" | "start" | "end";

interface Scene {
  id: number;
  start: number;
  end: number;
  text: string;
  frameTime: number;
  image?: { blob: Blob; url: string };
}

/** Subtitles loaded from an .srt/.txt file; they replace the recognised text. */
interface ImportedSubtitles {
  id: number;
  name: string;
  cues: SceneSpan[];
  joiner: string;
}

const STATUS_META: Record<Status, { label: string; tone?: "info" | "attention" | "success" | "critical" }> = {
  idle: { label: "Sẵn sàng" },
  extracting: { label: "Đang tách âm thanh", tone: "attention" },
  transcribing: { label: "Đang nhận dạng giọng nói", tone: "info" },
  capturing: { label: "Đang chụp khung hình", tone: "attention" },
  completed: { label: "Hoàn tất", tone: "success" },
  error: { label: "Lỗi", tone: "critical" },
};

const POSITION_OPTIONS = [
  { label: "Giữa câu phụ đề", value: "middle" },
  { label: "Đầu câu phụ đề", value: "start" },
  { label: "Cuối câu phụ đề", value: "end" },
];

let nextSceneId = 1;
let nextImportId = 1;
const subscribeNever = () => () => {};

function frameTimeFor(scene: Pick<Scene, "start" | "end">, position: FramePosition, videoDuration: number | null) {
  // Stay slightly inside the cue so the frame belongs to it rather than a cut on its boundary.
  const inset = Math.min(0.3, (scene.end - scene.start) * 0.2);
  const time =
    position === "start" ? scene.start + inset : position === "end" ? scene.end - inset : (scene.start + scene.end) / 2;
  const latest = (videoDuration ?? scene.end) - 0.05;
  return Math.max(0, Math.min(time, latest));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export default function SubtitleScenesPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileId, setFileId] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [language, setLanguage] = useState("vi");
  const [position, setPosition] = useState<FramePosition>("middle");
  const [status, setStatus] = useState<Status>("idle");
  const [stageDetail, setStageDetail] = useState("");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [transcript, setTranscript] = useState<{ key: string; meta: TranscribeResponse } | null>(null);
  const [sceneRange, setSceneRange] = useState<[number, number]>([2.5, 3.5]);
  // Which transcript + duration range the current scene list was built from.
  const [segmented, setSegmented] = useState<{ key: string; range: [number, number] } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportedSubtitles | null>(null);
  const [importNotice, setImportNotice] = useState<{ tone: "success" | "warning" | "critical"; message: string } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const imageUrlsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  const busy = status === "extracting" || status === "transcribing" || status === "capturing";
  // The length limit only exists for Groq; an imported subtitle file needs no recognition.
  const tooLong = videoDuration !== null && videoDuration > MAX_SPEECH_SECONDS && !imported;
  const transcriptKey = `${fileId}|${language}`;
  const hasTranscript = transcript?.key === transcriptKey;
  // Where the scene text comes from: the imported file if there is one, else Groq's transcript.
  const sourceKey = imported ? `file:${imported.id}` : transcriptKey;
  const hasSource = Boolean(imported) || hasTranscript;
  const segmentationKey = `${sourceKey}|${sceneRange[0]}-${sceneRange[1]}`;
  const scenesCurrent = hasSource && segmented?.key === segmentationKey && scenes.length > 0;
  const allCaptured = scenes.length > 0 && scenes.every((scene) => scene.image);

  // `false` during server render and hydration, the real value afterwards.
  const supportsFolder = useSyncExternalStore(subscribeNever, canPickDirectory, () => false);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    mountedRef.current = true;
    const urls = imageUrlsRef.current;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (busyRef.current) terminateFFmpeg();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  const releaseImages = useCallback((list: Scene[]) => {
    for (const scene of list) {
      if (!scene.image) continue;
      URL.revokeObjectURL(scene.image.url);
      imageUrlsRef.current.delete(scene.image.url);
    }
  }, []);

  const resetAll = useCallback(() => {
    setScenes((prev) => {
      releaseImages(prev);
      return [];
    });
    setTranscript(null);
    setStatus("idle");
    setStageDetail("");
    setProgress(0);
    setErrorMessage(null);
    setExportNotice(null);
  }, [releaseImages]);

  const handleDrop = useCallback(
    (_all: File[], accepted: File[], rejected: File[]) => {
      const next = accepted[0] ?? rejected[0];
      if (!next) return;
      resetAll();
      if (!next.type.startsWith("video/") && !/\.(mp4|m4v|mov|webm|mkv)$/i.test(next.name)) {
        setFile(null);
        setPreviewUrl(null);
        setVideoDuration(null);
        setStatus("error");
        setErrorMessage(`"${next.name}" không phải file video.`);
        return;
      }
      setFile(next);
      setFileId((id) => id + 1);
      setVideoDuration(null);
      setPreviewUrl(URL.createObjectURL(next));
    },
    [resetAll],
  );

  const clearFile = useCallback(() => {
    resetAll();
    setImported(null);
    setImportNotice(null);
    setFile(null);
    setPreviewUrl(null);
    setVideoDuration(null);
  }, [resetAll]);

  const handleAnalyze = useCallback(async () => {
    if (!file || busyRef.current || tooLong) return;
    const controller = new AbortController();
    abortRef.current = controller;
    busyRef.current = true;
    setErrorMessage(null);
    setExportNotice(null);

    try {
      // Three levels of reuse: the transcript (same video + language), the scene list with
      // its text edits (same duration range too), or nothing.
      let meta = hasTranscript ? transcript!.meta : null;
      if (!meta && !imported) {
        setStatus("extracting");
        const audio = await extractSpeechAudio(file, {
          durationHint: videoDuration,
          onStage: setStageDetail,
          onProgress: setProgress,
        });
        if (!mountedRef.current) return;

        setStatus("transcribing");
        setStageDetail(`Đang gửi ${formatBytes(audio.size)} âm thanh tới Groq Whisper…`);
        const result = await requestTranscription(audio, language, controller.signal);
        if (!mountedRef.current) return;
        if (result.segments.length === 0) throw new Error("Không phát hiện giọng nói trong video.");

        meta = result;
        setTranscript({ key: transcriptKey, meta: result });
      }

      let base: Scene[] = scenes;
      if (!scenesCurrent) {
        // Regroup the words into scenes of the requested length, cutting at sentence ends,
        // then commas, then pauses. Without word timings (translate mode) they are estimated.
        // Imported subtitles keep their own timings, refined by Groq's word timings if present.
        const joiner = imported ? imported.joiner : wordJoinerFor(language);
        const words = imported
          ? timeImportedWords(imported.cues, meta?.words ?? null, joiner)
          : meta!.words?.length
            ? meta!.words
            : approximateWords(meta!.segments, joiner);
        const spans = buildScenes(words, {
          minDuration: sceneRange[0],
          maxDuration: sceneRange[1],
          mediaDuration: videoDuration,
          joiner,
        });
        if (spans.length === 0) throw new Error("Không phát hiện giọng nói trong video.");
        base = spans.map((span) => ({ id: nextSceneId++, ...span, frameTime: 0 }));
        setSegmented({ key: segmentationKey, range: sceneRange });
      }

      releaseImages(scenes);
      const prepared = base.map((scene) => ({
        ...scene,
        frameTime: frameTimeFor(scene, position, videoDuration),
        image: undefined,
      }));
      setScenes(prepared);
      setStatus("capturing");
      setProgress(0);
      setStageDetail(`Đang chụp ${prepared.length} khung hình…`);

      await captureFrames(
        file,
        prepared.map((scene) => scene.frameTime),
        {
          signal: controller.signal,
          onStage: setStageDetail,
          onFrame: (index, blob) => {
            if (!mountedRef.current) return;
            const url = URL.createObjectURL(blob);
            imageUrlsRef.current.add(url);
            const id = prepared[index].id;
            setScenes((prev) => prev.map((scene) => (scene.id === id ? { ...scene, image: { blob, url } } : scene)));
            setProgress(((index + 1) / prepared.length) * 100);
          },
        },
      );
      if (!mountedRef.current) return;
      setStageDetail("");
      setStatus("completed");
    } catch (error) {
      if (!mountedRef.current) return;
      setStageDetail("");
      if (controller.signal.aborted || isTerminationError(error) || isUserCancel(error)) {
        setStatus("idle");
        setErrorMessage("Đã hủy.");
        return;
      }
      console.error("[subtitle-scenes]", error);
      setStatus("error");
      setErrorMessage(describeError(error));
    } finally {
      busyRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [file, hasTranscript, imported, language, position, releaseImages, scenes, sceneRange, scenesCurrent, segmentationKey, tooLong, transcript, transcriptKey, videoDuration]);

  const handleImportDrop = useCallback(async (_all: File[], accepted: File[], rejected: File[]) => {
    const picked = accepted[0] ?? rejected[0];
    if (!picked) return;
    if (!/\.(srt|vtt|txt)$/i.test(picked.name)) {
      setImportNotice({ tone: "critical", message: `"${picked.name}" không phải file .srt, .vtt hoặc .txt.` });
      return;
    }
    try {
      const cues = parseSubtitleFile(await picked.text());
      const joiner = joinerForText(cues.map((cue) => cue.text).join(" "));
      setImported({ id: nextImportId++, name: picked.name, cues, joiner });
      setImportNotice(null);
    } catch (error) {
      setImportNotice({ tone: "critical", message: describeError(error, "Không đọc được file phụ đề.") });
    }
  }, []);

  const removeImported = useCallback(() => {
    setImported(null);
    setImportNotice(null);
  }, []);

  /** Keeps the scenes and their frames; only their text is re-split from the imported subtitles. */
  const handleApplyImported = useCallback(() => {
    if (!imported || scenes.length === 0) return;
    const reference = hasTranscript ? transcript!.meta.words : null;
    const words = timeImportedWords(imported.cues, reference, imported.joiner);
    const { texts, unassigned } = distributeToScenes(words, scenes, imported.joiner);
    setScenes((prev) => prev.map((scene, index) => ({ ...scene, text: texts[index] ?? scene.text })));
    // The scenes now count as built from this file, at the range they were originally cut with.
    const range = segmented?.range ?? sceneRange;
    setSegmented({ key: `${sourceKey}|${range[0]}-${range[1]}`, range });

    const empty = texts.filter((text) => !text).length;
    const problems = [
      empty > 0 && `${empty} cảnh không có lời nào trong file`,
      unassigned > 0 && `${unassigned} từ nằm ngoài mọi cảnh nên bị bỏ qua (cảnh đã bị xóa hoặc mốc thời gian lệch)`,
    ].filter(Boolean);
    setImportNotice({
      tone: problems.length > 0 ? "warning" : "success",
      message:
        `Đã chia lại phụ đề cho ${scenes.length} cảnh, khung hình giữ nguyên` +
        (reference?.length ? ", căn theo thời gian từng từ Groq nghe được." : ".") +
        (problems.length > 0 ? ` Lưu ý: ${problems.join("; ")}.` : ""),
    });
  }, [hasTranscript, imported, sceneRange, scenes, segmented, sourceKey, transcript]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    if (status === "extracting") terminateFFmpeg();
  }, [status]);

  const removeScene = useCallback(
    (scene: Scene) => {
      releaseImages([scene]);
      setScenes((prev) => prev.filter((s) => s.id !== scene.id));
    },
    [releaseImages],
  );

  const seekPreview = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = time;
    video.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const digits = Math.max(3, String(scenes.length).length);
  const frameName = useCallback((index: number) => `${String(index + 1).padStart(digits, "0")}.jpg`, [digits]);
  const folderName = `${file?.name.replace(/\.[^.]+$/, "") || "video"}_scenes`;

  const buildExportFiles = useCallback((): ExportFile[] => {
    const content = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: { fileName: file?.name ?? null, duration: videoDuration === null ? null : round3(videoDuration) },
      language: transcript?.meta.language ?? language,
      subtitleSource: imported ? { type: "file", fileName: imported.name } : { type: "groq" },
      detectedLanguage: transcript?.meta.detectedLanguage ?? null,
      framePosition: position,
      sceneDuration: segmented ? { min: segmented.range[0], max: segmented.range[1] } : null,
      sceneCount: scenes.length,
      scenes: scenes.map((scene, index) => ({
        index: index + 1,
        frame: frameName(index),
        frameTime: round3(scene.frameTime),
        start: round3(scene.start),
        end: round3(scene.end),
        duration: round3(scene.end - scene.start),
        text: scene.text,
      })),
    };
    return [
      ...scenes.map((scene, index) => ({ path: frameName(index), data: scene.image!.blob })),
      {
        path: "content.json",
        data: new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }),
        compress: true,
      },
    ];
  }, [file, frameName, imported, language, position, scenes, segmented, transcript, videoDuration]);

  const handleSaveFolder = useCallback(async () => {
    setExporting(true);
    setExportNotice(null);
    try {
      const name = await saveToPickedDirectory(folderName, buildExportFiles());
      setExportNotice(`Đã lưu ${scenes.length} khung hình và content.json vào thư mục “${name}”.`);
    } catch (error) {
      if (!isUserCancel(error)) setErrorMessage(describeError(error, "Không lưu được thư mục."));
    } finally {
      setExporting(false);
    }
  }, [buildExportFiles, folderName, scenes.length]);

  const handleDownloadZip = useCallback(async () => {
    setExporting(true);
    setExportNotice(null);
    try {
      await downloadAsZip(folderName, buildExportFiles());
      setExportNotice(`Đã tạo ${folderName}.zip – giải nén để có thư mục khung hình và content.json.`);
    } catch (error) {
      setErrorMessage(describeError(error, "Không tạo được file ZIP."));
    } finally {
      setExporting(false);
    }
  }, [buildExportFiles, folderName]);

  const folderPreview = useMemo(() => {
    const count = scenes.length || 3;
    const lines = [`${folderName}/`];
    const names = count <= 3 ? Array.from({ length: count }, (_, i) => frameName(i)) : [frameName(0), frameName(1), "…", frameName(count - 1)];
    names.forEach((name) => lines.push(`├─ ${name}`));
    lines.push("└─ content.json");
    return lines.join("\n");
  }, [folderName, frameName, scenes.length]);

  const statusMeta = STATUS_META[status];
  const canExport = allCaptured && !busy && !exporting;

  return (
    <Page
      fullWidth
      backAction={{ content: "Tổng quan", url: "/" }}
      title="Phân cảnh theo phụ đề"
      subtitle="Nhận dạng phụ đề rồi chụp một khung hình cho mỗi câu thoại. Xuất ra thư mục gồm ảnh đánh số và content.json."
      primaryAction={{
        content: !hasSource
          ? "Phân tích video"
          : !scenesCurrent
            ? scenes.length > 0
              ? "Chia lại cảnh"
              : "Tạo phân cảnh"
            : "Chụp lại khung hình",
        onAction: handleAnalyze,
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
                {!file ? (
                  <DropZone accept="video/*" type="file" allowMultiple={false} onDrop={handleDrop} label="Video" labelHidden>
                    <DropZone.FileUpload actionTitle="Chọn video" actionHint="MP4, MOV, WebM – tối đa 20 phút" />
                  </DropZone>
                ) : (
                  <>
                    <BlockStack>
                      <Text as="p" fontWeight="semibold" breakWord>
                        {file.name}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {formatBytes(file.size)}
                        {videoDuration !== null && ` · ${formatTimecode(videoDuration, { fractional: false })}`}
                      </Text>
                    </BlockStack>
                    {previewUrl && (
                      <video
                        ref={videoRef}
                        src={previewUrl}
                        controls
                        preload="metadata"
                        style={{ width: "100%", maxHeight: 400, borderRadius: "var(--p-border-radius-200)", background: "#000" }}
                        onLoadedMetadata={(event) => {
                          const seconds = event.currentTarget.duration;
                          if (Number.isFinite(seconds)) setVideoDuration(seconds);
                        }}
                      />
                    )}
                    {tooLong && videoDuration !== null && (
                      <Banner tone="critical" title="Video quá dài">
                        <p>
                          Video dài {formatTimecode(videoDuration, { fractional: false })}, tối đa{" "}
                          {formatTimecode(MAX_SPEECH_SECONDS)}. Hãy dùng công cụ Cắt video để chia nhỏ trước.
                        </p>
                      </Banner>
                    )}
                  </>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Các cảnh ({scenes.length})
                  </Text>
                  {transcript?.meta.detectedLanguage && (
                    <Badge>{`Ngôn ngữ nhận diện: ${transcript.meta.detectedLanguage}`}</Badge>
                  )}
                </InlineStack>

                {scenes.length === 0 ? (
                  <Box paddingBlock="600">
                    <Text as="p" tone="subdued" alignment="center">
                      {file
                        ? imported
                          ? "Bấm “Tạo phân cảnh” để chia cảnh theo file phụ đề đã nhập và chụp khung hình cho từng câu."
                          : "Bấm “Phân tích video” để nhận dạng phụ đề và chụp khung hình cho từng câu."
                        : "Tải video lên để bắt đầu."}
                    </Text>
                  </Box>
                ) : (
                  <InlineGrid columns={{ xs: 1, sm: 2, xl: 3 }} gap="400">
                    {scenes.map((scene, index) => (
                      <Box
                        key={scene.id}
                        borderColor="border"
                        borderWidth="025"
                        borderRadius="300"
                        background="bg-surface-secondary"
                        overflowX="hidden"
                        overflowY="hidden"
                      >
                        <button
                          type="button"
                          onClick={() => seekPreview(scene.frameTime)}
                          title="Xem vị trí này trên video"
                          style={{
                            display: "block",
                            width: "100%",
                            aspectRatio: "16 / 9",
                            padding: 0,
                            border: 0,
                            background: "#000",
                            cursor: "pointer",
                          }}
                        >
                          {scene.image ? (
                            // eslint-disable-next-line @next/next/no-img-element -- local blob URL, nothing for next/image to optimise
                            <img
                              src={scene.image.url}
                              alt={`Khung hình ${index + 1}`}
                              style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                            />
                          ) : (
                            <span style={{ display: "grid", placeItems: "center", height: "100%" }}>
                              {busy ? <Spinner size="small" accessibilityLabel="Đang chụp" /> : null}
                            </span>
                          )}
                        </button>
                        <Box padding="300">
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center" wrap={false}>
                              <InlineStack gap="200" blockAlign="center">
                                <Badge tone="info">{frameName(index).replace(".jpg", "")}</Badge>
                                <Badge
                                  tone={
                                    segmented &&
                                    (scene.end - scene.start < segmented.range[0] - 0.05 ||
                                      scene.end - scene.start > segmented.range[1] + 0.05)
                                      ? "warning"
                                      : undefined
                                  }
                                >
                                  {`${(scene.end - scene.start).toFixed(1)}s`}
                                </Badge>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {formatTimecode(scene.start)} → {formatTimecode(scene.end)}
                                </Text>
                              </InlineStack>
                              <Tooltip content="Xóa cảnh này">
                                <Button
                                  icon={DeleteIcon}
                                  variant="tertiary"
                                  tone="critical"
                                  accessibilityLabel={`Xóa cảnh ${index + 1}`}
                                  onClick={() => removeScene(scene)}
                                  disabled={busy}
                                />
                              </Tooltip>
                            </InlineStack>
                            <TextField
                              label={`Phụ đề cảnh ${index + 1}`}
                              labelHidden
                              value={scene.text}
                              onChange={(value) =>
                                setScenes((prev) => prev.map((s) => (s.id === scene.id ? { ...s, text: value } : s)))
                              }
                              multiline={2}
                              autoComplete="off"
                            />
                          </BlockStack>
                        </Box>
                      </Box>
                    ))}
                  </InlineGrid>
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
                  Cài đặt
                </Text>
                <Select
                  label="Ngôn ngữ phụ đề"
                  options={SPEECH_LANGUAGE_OPTIONS}
                  value={language}
                  onChange={setLanguage}
                  disabled={busy}
                  helpText={speechLanguageHelpText(language)}
                />
                <RangeSlider
                  label="Độ dài mỗi cảnh (giây)"
                  value={sceneRange}
                  min={1}
                  max={10}
                  step={0.5}
                  output
                  onChange={(value) => {
                    if (Array.isArray(value)) setSceneRange([value[0], value[1]]);
                  }}
                  disabled={busy}
                  helpText={
                    hasSource && scenes.length > 0 && !scenesCurrent
                      ? `${sceneRange[0]}–${sceneRange[1]} giây. Bấm “Chia lại cảnh” để áp dụng (không cần nhận dạng lại, nhưng các chỉnh sửa phụ đề sẽ bị thay thế).`
                      : `${sceneRange[0]}–${sceneRange[1]} giây. Cảnh được cắt ưu tiên sau dấu chấm, rồi dấu phẩy, rồi chỗ ngắt hơi.`
                  }
                />
                <Select
                  label="Vị trí chụp khung hình"
                  options={POSITION_OPTIONS}
                  value={position}
                  onChange={(value) => setPosition(value as FramePosition)}
                  disabled={busy}
                  helpText={
                    scenesCurrent
                      ? "Đổi vị trí rồi bấm “Chụp lại khung hình” – phụ đề và các chỉnh sửa được giữ nguyên."
                      : "Mặc định chụp ở giữa thời gian của mỗi câu phụ đề."
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Phụ đề từ file
                </Text>
                {!imported ? (
                  <DropZone
                    accept=".srt,.vtt,.txt"
                    type="file"
                    allowMultiple={false}
                    onDrop={handleImportDrop}
                    disabled={busy}
                    label="File phụ đề"
                    labelHidden
                  >
                    <DropZone.FileUpload actionTitle="Chọn file .srt / .txt" actionHint="Có mốc thời gian dạng SRT" />
                  </DropZone>
                ) : (
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="start" gap="200" wrap={false}>
                      <BlockStack gap="050">
                        <Text as="p" fontWeight="semibold" breakWord>
                          {imported.name}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {imported.cues.length} câu · {formatTimecode(imported.cues[0].start, { fractional: false })} →{" "}
                          {formatTimecode(imported.cues[imported.cues.length - 1].end, { fractional: false })}
                        </Text>
                      </BlockStack>
                      <Button variant="plain" tone="critical" onClick={removeImported} disabled={busy}>
                        Gỡ
                      </Button>
                    </InlineStack>
                    {videoDuration !== null && imported.cues[imported.cues.length - 1].end > videoDuration + 1 && (
                      <Banner tone="warning">
                        <p>Mốc thời gian trong file dài hơn video – có thể file không khớp với video này.</p>
                      </Banner>
                    )}
                    {scenes.length > 0 && (
                      <Button variant="primary" onClick={handleApplyImported} disabled={busy} fullWidth>
                        {`Thay phụ đề vào ${scenes.length} cảnh hiện có`}
                      </Button>
                    )}
                  </BlockStack>
                )}
                <Text as="p" variant="bodySm" tone="subdued">
                  {!imported
                    ? "Dùng khi Groq nhận dạng sai từ: nội dung và mốc thời gian trong file sẽ thay cho kết quả nhận dạng."
                    : scenes.length > 0
                      ? "“Thay phụ đề” giữ nguyên khung hình và chia lại lời theo mốc thời gian của từng cảnh. “Chia lại cảnh” cắt cảnh mới theo câu trong file."
                      : "Cảnh sẽ được chia theo nội dung và mốc thời gian trong file, không cần gọi Groq."}
                  {imported && hasTranscript && " Thời gian từng từ được căn thêm theo giọng nói Groq đã nhận dạng."}
                </Text>
                {importNotice && (
                  <Banner tone={importNotice.tone} onDismiss={() => setImportNotice(null)}>
                    <p>{importNotice.message}</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Xuất kết quả
                </Text>
                <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                  <pre style={{ margin: 0, fontFamily: "var(--p-font-family-mono)", fontSize: 12, whiteSpace: "pre-wrap" }}>
                    {folderPreview}
                  </pre>
                </Box>
                {supportsFolder && (
                  <Button variant="primary" onClick={handleSaveFolder} disabled={!canExport} loading={exporting} fullWidth>
                    Lưu vào thư mục trên máy…
                  </Button>
                )}
                <Button onClick={handleDownloadZip} disabled={!canExport} fullWidth>
                  Tải về dạng ZIP
                </Button>
                <Text as="p" variant="bodySm" tone="subdued">
                  {supportsFolder
                    ? "Chọn một thư mục, app sẽ tạo thư mục con chứa ảnh và content.json. Nội dung phụ đề đã sửa sẽ được xuất theo."
                    : "Trình duyệt này không hỗ trợ ghi thẳng vào thư mục (cần Chrome hoặc Edge), hãy tải ZIP rồi giải nén."}
                </Text>
                {exportNotice && (
                  <Banner tone="success" onDismiss={() => setExportNotice(null)}>
                    <p>{exportNotice}</p>
                  </Banner>
                )}
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
                {busy ? (
                  <BlockStack gap="200">
                    {status === "transcribing" ? (
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <Spinner size="small" accessibilityLabel="Đang nhận dạng" />
                        <Text as="p" variant="bodySm" tone="subdued">
                          {stageDetail}
                        </Text>
                      </InlineStack>
                    ) : (
                      <>
                        <ProgressBar progress={progress} size="small" tone="primary" />
                        <Text as="p" variant="bodySm" tone="subdued">
                          {stageDetail} {progress > 0 && `${Math.round(progress)}%`}
                        </Text>
                      </>
                    )}
                    <InlineStack align="end">
                      <Button tone="critical" variant="plain" onClick={handleCancel}>
                        Hủy
                      </Button>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {status === "completed"
                      ? `Đã tạo ${scenes.length} cảnh. Kiểm tra, sửa phụ đề nếu cần rồi xuất kết quả.`
                      : file
                        ? "Sẵn sàng. Bấm “Phân tích video” ở đầu trang."
                        : "Tải video lên để bắt đầu."}
                  </Text>
                )}
                {errorMessage && (
                  <Banner tone={errorMessage === "Đã hủy." ? "info" : "critical"} onDismiss={() => setErrorMessage(null)}>
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
