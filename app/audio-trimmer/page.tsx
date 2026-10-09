"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
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
  Tooltip,
} from "@shopify/polaris";
import { ClockIcon, DeleteIcon, MagicIcon, PauseCircleIcon, PlayIcon, PlusIcon, ReplayIcon } from "@shopify/polaris-icons";
import { formatBytes, formatTimecode, parseTimecode } from "../_lib/format";
import {
  FFmpegExecError,
  describeError,
  execFFmpeg,
  getFFmpeg,
  isTerminationError,
  probeMedia,
  takeOutputFile,
  terminateFFmpeg,
  withInputFile,
  type MediaEngine,
  type ProbeStream,
} from "../_lib/ffmpeg";
import { Waveform, type Interval, type Peaks, type Region } from "./waveform";

type Mode = "remove" | "keep";
type OutFormat = "mp3" | "m4a" | "ogg" | "wav" | "flac";
type LossyFormat = "mp3" | "m4a" | "ogg";
type Quality = "high" | "balanced" | "small";
type Stage = "empty" | "loading" | "ready" | "exporting" | "detecting" | "error";

interface SourceInfo {
  /** Absolute stream index of the audio track used, for `[0:<index>]`. */
  streamIndex: number;
  codec: string;
  channels?: number;
  sampleRate?: number;
}

interface TrimResult {
  url: string;
  name: string;
  size: number;
  duration: number;
  /** Settings and cuts that produced the file, to flag it as outdated after edits. */
  key: string;
}

const MODE_OPTIONS = [
  { label: "Xóa các đoạn đã chọn, giữ phần còn lại", value: "remove" },
  { label: "Chỉ giữ các đoạn đã chọn", value: "keep" },
];

const FORMATS: Record<OutFormat, { label: string; ext: string; mime: string }> = {
  mp3: { label: "MP3", ext: "mp3", mime: "audio/mpeg" },
  m4a: { label: "M4A (AAC)", ext: "m4a", mime: "audio/mp4" },
  ogg: { label: "OGG (Vorbis)", ext: "ogg", mime: "audio/ogg" },
  wav: { label: "WAV (không nén)", ext: "wav", mime: "audio/wav" },
  flac: { label: "FLAC (không mất chất lượng)", ext: "flac", mime: "audio/flac" },
};
const FORMAT_OPTIONS = (Object.keys(FORMATS) as OutFormat[]).map((value) => ({ label: FORMATS[value].label, value }));

// kbps per quality level. Vorbis is variable bitrate, so its numbers are approximate.
const BITRATES: Record<LossyFormat, Record<Quality, number>> = {
  mp3: { high: 320, balanced: 192, small: 128 },
  m4a: { high: 256, balanced: 160, small: 96 },
  ogg: { high: 256, balanced: 160, small: 112 },
};
const VORBIS_QUALITY: Record<Quality, string> = { high: "8", balanced: "5", small: "3" };

const FADE_OPTIONS = [
  { label: "Không", value: "0" },
  { label: "0,5 giây", value: "0.5" },
  { label: "1 giây", value: "1" },
  { label: "2 giây", value: "2" },
  { label: "3 giây", value: "3" },
  { label: "5 giây", value: "5" },
];

const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64];

const SILENCE_THRESHOLD_OPTIONS = [
  { label: "Rất nhạy (-25 dB) – cả tiếng ồn nhỏ", value: "-25" },
  { label: "Nhạy (-30 dB)", value: "-30" },
  { label: "Bình thường (-40 dB)", value: "-40" },
  { label: "Chỉ im lặng hoàn toàn (-50 dB)", value: "-50" },
];
const SILENCE_LENGTH_OPTIONS = [
  { label: "Từ 0,5 giây", value: "0.5" },
  { label: "Từ 1 giây", value: "1" },
  { label: "Từ 2 giây", value: "2" },
  { label: "Từ 3 giây", value: "3" },
  { label: "Từ 5 giây", value: "5" },
];
/** Silence kept on each side of a detected gap, so cuts do not clip the surrounding words. */
const SILENCE_PADDING = 0.15;

/** Short fade at every join so cuts do not click. */
const JOIN_FADE_SECONDS = 0.012;
/** Pieces shorter than this are dropped from the output. */
const MIN_PIECE_SECONDS = 0.01;
/** Waveform data budget: ~12 MB of 16-bit samples, whatever the length of the file. */
const PEAK_SAMPLE_BUDGET = 6_000_000;

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff?|amr|ac3|mka|weba)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|3gp|mpg|mpeg|ts|mts)$/i;

let nextRegionId = 1;

const isLossy = (format: OutFormat): format is LossyFormat => format === "mp3" || format === "m4a" || format === "ogg";

function defaultFormat(fileName: string): OutFormat {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "wav" || ext === "aif" || ext === "aiff") return "wav";
  if (ext === "flac") return "flac";
  if (ext === "ogg" || ext === "oga" || ext === "opus") return "ogg";
  if (ext === "m4a" || ext === "aac") return "m4a";
  return "mp3";
}

/** Valid regions clipped to the file, sorted and with overlaps merged. */
function mergeRegions(regions: Region[], duration: number): Interval[] {
  const sorted = regions
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter((r) => r.end - r.start > 0)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Parts of the file that end up in the output, in timeline order. */
function keptIntervals(regions: Region[], mode: Mode, duration: number): Interval[] {
  const merged = mergeRegions(regions, duration);
  let kept = merged;
  if (mode === "remove") {
    kept = [];
    let cursor = 0;
    for (const r of merged) {
      if (r.start > cursor) kept.push({ start: cursor, end: r.start });
      cursor = r.end;
    }
    if (cursor < duration) kept.push({ start: cursor, end: duration });
  }
  return kept.filter((r) => r.end - r.start >= MIN_PIECE_SECONDS);
}

function chooseAudioStream(streams: ProbeStream[]): SourceInfo | null {
  const audio = streams.filter((s) => s.codec_type === "audio");
  const stream = audio.find((s) => s.disposition?.default === 1) ?? audio[0];
  if (!stream) return null;
  return {
    streamIndex: stream.index,
    codec: stream.codec_name ?? "unknown",
    channels: stream.channels,
    sampleRate: Number(stream.sample_rate) || undefined,
  };
}

function codecArgs(format: OutFormat, quality: Quality, source: SourceInfo): string[] {
  switch (format) {
    case "mp3":
      // MP3 is stereo at most and tops out at 48 kHz.
      return [
        ...((source.channels ?? 2) > 2 ? ["-ac", "2"] : []),
        ...((source.sampleRate ?? 0) > 48000 ? ["-ar", "48000"] : []),
        "-c:a", "libmp3lame", "-b:a", `${BITRATES.mp3[quality]}k`, "-id3v2_version", "3",
      ];
    case "m4a":
      return ["-c:a", "aac", "-b:a", `${BITRATES.m4a[quality]}k`, "-movflags", "+faststart"];
    case "ogg":
      return ["-c:a", "libvorbis", "-q:a", VORBIS_QUALITY[quality]];
    case "wav":
      return ["-c:a", "pcm_s16le"];
    case "flac":
      return ["-c:a", "flac"];
  }
}

/**
 * One filter graph: cut each kept piece with atrim (sample-accurate), fade the joins so they do
 * not click, concatenate, then apply the overall fade in/out.
 */
function buildFilter(pieces: Interval[], source: SourceInfo, duration: number, opts: { fadeIn: number; fadeOut: number; smoothJoins: boolean }) {
  const input = `[0:${source.streamIndex}]`;
  const chains: string[] = [];
  const labels = pieces.map((_, i) => `[p${i}]`);
  const splitLabels = pieces.map((_, i) => `[s${i}]`);
  if (pieces.length > 1) chains.push(`${input}asplit=${pieces.length}${splitLabels.join("")}`);
  pieces.forEach((piece, i) => {
    const length = piece.end - piece.start;
    const filters = [`atrim=start=${piece.start.toFixed(4)}:end=${piece.end.toFixed(4)}`, "asetpts=PTS-STARTPTS"];
    if (opts.smoothJoins) {
      const fade = Math.min(JOIN_FADE_SECONDS, length / 2);
      if (piece.start > 0.001) filters.push(`afade=t=in:st=0:d=${fade.toFixed(4)}`);
      if (piece.end < duration - 0.001) filters.push(`afade=t=out:st=${(length - fade).toFixed(4)}:d=${fade.toFixed(4)}`);
    }
    chains.push(`${pieces.length > 1 ? splitLabels[i] : input}${filters.join(",")}${labels[i]}`);
  });

  const total = pieces.reduce((sum, p) => sum + p.end - p.start, 0);
  const finals: string[] = [];
  const fadeIn = Math.min(opts.fadeIn, total / 2);
  const fadeOut = Math.min(opts.fadeOut, total / 2);
  if (fadeIn > 0) finals.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) finals.push(`afade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);

  if (pieces.length > 1) {
    chains.push(`${labels.join("")}concat=n=${pieces.length}:v=0:a=1${finals.length ? `,${finals.join(",")}` : ""}[out]`);
  } else if (finals.length) {
    chains.push(`${labels[0]}${finals.join(",")}[out]`);
  } else {
    // Single piece without fades: just rename its output.
    chains[chains.length - 1] = chains[chains.length - 1].replace(/\[p0\]$/, "[out]");
  }
  return { graph: chains.join(";"), total };
}

/** Decodes the track to rectified mono 16-bit PCM at a low rate for drawing the waveform. */
async function loadPeaks(
  engine: MediaEngine,
  inputPath: string,
  source: SourceInfo,
  duration: number | undefined,
  onProgress: (fraction: number) => void,
): Promise<Peaks> {
  const rate = Math.max(200, Math.min(8000, Math.floor(PEAK_SAMPLE_BUDGET / Math.max(duration ?? 3600, 1))));
  const outputPath = `/peaks-${Date.now()}.raw`;
  const run = (rectify: boolean) =>
    execFFmpeg(
      engine,
      [
        "-i", inputPath,
        "-map", `0:${source.streamIndex}`,
        "-af", rectify ? "aformat=channel_layouts=mono,aeval=abs(val(0))" : "aformat=channel_layouts=mono",
        "-ar", String(rate),
        "-f", "s16le", "-c:a", "pcm_s16le",
        "-y", outputPath,
      ],
      { onTime: (seconds) => duration && onProgress(Math.min(1, seconds / duration)) },
    );
  try {
    await run(true);
  } catch (error) {
    // Rectifying first keeps the envelope of high frequencies; without aeval, plain samples still draw fine.
    if (!(error instanceof FFmpegExecError)) throw error;
    await run(false);
  }
  const data = await engine.readFile(outputPath);
  await engine.deleteFile(outputPath).catch(() => undefined);
  const samples = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.byteLength - (data.byteLength % 2))));
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] < 0 ? -samples[i] : samples[i];
    if (value > max) max = value;
  }
  return { samples, rate, max };
}

/** Runs FFmpeg's silencedetect and returns the silent stretches. */
async function detectSilences(
  engine: MediaEngine,
  inputPath: string,
  source: SourceInfo,
  duration: number,
  thresholdDb: number,
  minLength: number,
  onProgress: (fraction: number) => void,
): Promise<Interval[]> {
  const silences: Interval[] = [];
  let openStart: number | null = null;
  await execFFmpeg(
    engine,
    [
      "-i", inputPath,
      "-map", `0:${source.streamIndex}`,
      "-af", `silencedetect=noise=${thresholdDb}dB:d=${minLength}`,
      "-f", "null", "-",
    ],
    {
      onTime: (seconds) => onProgress(Math.min(1, seconds / duration)),
      onLog: (message) => {
        const start = message.match(/silence_start:\s*(-?[\d.]+)/);
        if (start) openStart = Math.max(0, Number(start[1]));
        const end = message.match(/silence_end:\s*([\d.]+)/);
        if (end && openStart !== null) {
          silences.push({ start: openStart, end: Number(end[1]) });
          openStart = null;
        }
      },
    },
  );
  // Silence running to the end of the file has no silence_end line.
  if (openStart !== null) silences.push({ start: openStart, end: duration });
  return silences;
}

/** Text field for a time that keeps the user's typing until it parses, then commits it. */
function TimeField({
  label,
  value,
  error,
  disabled,
  onCommit,
  onPickCurrent,
}: {
  label: string;
  value: number;
  error?: string;
  disabled: boolean;
  onCommit: (seconds: number) => void;
  onPickCurrent: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && parseTimecode(draft) === null;
  return (
    <TextField
      label={label}
      labelHidden
      prefix={label}
      value={draft ?? formatTimecode(value)}
      onChange={(text) => {
        setDraft(text);
        const seconds = parseTimecode(text);
        if (seconds !== null) onCommit(seconds);
      }}
      onBlur={() => {
        if (!invalid) setDraft(null);
      }}
      error={invalid ? "Sai định dạng (vd: 01:30.5)" : error}
      autoComplete="off"
      disabled={disabled}
      connectedRight={
        <Tooltip content="Lấy vị trí đang phát">
          <Button
            icon={ClockIcon}
            accessibilityLabel={`Đặt ${label.toLowerCase()} bằng vị trí đang phát`}
            onClick={() => {
              setDraft(null);
              onPickCurrent();
            }}
            disabled={disabled}
          />
        </Tooltip>
      }
    />
  );
}

export default function AudioTrimmerPage() {
  const [file, setFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [duration, setDuration] = useState(0);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const [regions, setRegions] = useState<Region[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("remove");
  const [format, setFormat] = useState<OutFormat>("mp3");
  const [quality, setQuality] = useState<Quality>("high");
  const [fadeIn, setFadeIn] = useState("0");
  const [fadeOut, setFadeOut] = useState("0");
  const [smoothJoins, setSmoothJoins] = useState(true);
  const [skipCuts, setSkipCuts] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [silenceThreshold, setSilenceThreshold] = useState("-40");
  const [silenceLength, setSilenceLength] = useState("1");
  const [stage, setStage] = useState<Stage>("empty");
  const [stageDetail, setStageDetail] = useState("");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<TrimResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  /** End of the region being previewed; playback pauses there and skips nothing until then. */
  const previewEndRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);

  const busy = stage === "loading" || stage === "exporting" || stage === "detecting";
  const loaded = peaks !== null && source !== null && duration > 0;

  const regionErrors = useMemo(
    () => new Map(regions.map((r) => [r.id, r.end - r.start < MIN_PIECE_SECONDS ? "Phải sau điểm bắt đầu" : undefined])),
    [regions],
  );
  const regionsValid = regions.every((r) => !regionErrors.get(r.id));
  const kept = useMemo(() => (loaded ? keptIntervals(regions, mode, duration) : []), [duration, loaded, mode, regions]);
  const keptTotal = kept.reduce((sum, p) => sum + p.end - p.start, 0);

  const exportKey = JSON.stringify([kept, format, isLossy(format) && quality, fadeIn, fadeOut, smoothJoins]);
  const resultOutdated = result !== null && result.key !== exportKey;

  useEffect(() => {
    if (!audioUrl) return;
    return () => URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => {
    if (!result) return;
    return () => URL.revokeObjectURL(result.url);
  }, [result]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (busyRef.current) terminateFFmpeg();
    };
  }, []);

  // While playing: stop at the end of a previewed region, otherwise jump over the parts that will be cut.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        const t = audio.currentTime;
        const stopAt = previewEndRef.current;
        if (stopAt !== null) {
          if (t >= stopAt) {
            audio.pause();
            previewEndRef.current = null;
          }
        } else if (skipCuts && kept.length > 0) {
          const inside = kept.some((p) => p.start <= t && t < p.end);
          if (!inside) {
            const next = kept.find((p) => p.start > t);
            if (next) audio.currentTime = next.start;
            else audio.pause();
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [kept, playing, skipCuts]);

  const resetForNewFile = useCallback(() => {
    audioRef.current?.pause();
    setResult(null);
    setRegions([]);
    setSelectedId(null);
    setPeaks(null);
    setSource(null);
    setDuration(0);
    setZoom(1);
    setPlaybackError(false);
    setCurrentTime(0);
    setProgress(0);
    setStageDetail("");
    setErrorMessage(null);
    setNotice(null);
  }, []);

  const loadFile = useCallback(
    async (next: File) => {
      resetForNewFile();
      setFile(next);
      setAudioUrl(URL.createObjectURL(next));
      setFormat(defaultFormat(next.name));
      setStage("loading");
      setStageDetail("Đang đọc file…");
      busyRef.current = true;
      cancelledRef.current = false;
      try {
        const ffmpeg = await getFFmpeg(setStageDetail);
        await withInputFile(ffmpeg, next, async (inputPath) => {
          const probe = await probeMedia(ffmpeg, inputPath);
          const info = chooseAudioStream(probe.streams ?? []);
          if (!info) throw new Error("File này không có âm thanh.");
          const probed = Number(probe.format?.duration) || undefined;
          setStageDetail("Đang vẽ dạng sóng…");
          const data = await loadPeaks(ffmpeg, inputPath, info, probed, (fraction) => setProgress(fraction * 100));
          if (!mountedRef.current) return;
          const length = probed ?? data.samples.length / data.rate;
          if (!(length > 0)) throw new Error("Không đọc được độ dài âm thanh.");
          setSource(info);
          setDuration(length);
          setPeaks(data);
        });
        if (!mountedRef.current) return;
        setStage("ready");
      } catch (error) {
        if (!mountedRef.current) return;
        if (cancelledRef.current || isTerminationError(error)) {
          setFile(null);
          setAudioUrl(null);
          setStage("empty");
          return;
        }
        console.error("[audio-trimmer] load", error);
        setStage("error");
        setErrorMessage(`Không đọc được file: ${describeError(error)}`);
      } finally {
        busyRef.current = false;
        if (mountedRef.current) {
          setStageDetail("");
          setProgress(0);
        }
      }
    },
    [resetForNewFile],
  );

  const handleDrop = useCallback(
    (_all: File[], accepted: File[], rejected: File[]) => {
      const next = accepted[0] ?? rejected[0];
      if (!next) return;
      const isMedia =
        next.type.startsWith("audio/") || next.type.startsWith("video/") || AUDIO_EXTENSIONS.test(next.name) || VIDEO_EXTENSIONS.test(next.name);
      if (!isMedia) {
        setErrorMessage(`"${next.name}" không phải file âm thanh hoặc video.`);
        return;
      }
      void loadFile(next);
    },
    [loadFile],
  );

  const clearFile = useCallback(() => {
    resetForNewFile();
    setFile(null);
    setAudioUrl(null);
    setStage("empty");
  }, [resetForNewFile]);

  // ---------------------------------------------------------------- playback

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    previewEndRef.current = null;
    if (audio) audio.currentTime = seconds;
    setCurrentTime(seconds);
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || playbackError) return;
    previewEndRef.current = null;
    if (audio.paused) void audio.play().catch(() => setPlaybackError(true));
    else audio.pause();
  }, [playbackError]);

  const previewRange = useCallback(
    (start: number, end: number) => {
      const audio = audioRef.current;
      if (!audio || playbackError) return;
      audio.currentTime = start;
      previewEndRef.current = end;
      void audio.play().catch(() => setPlaybackError(true));
    },
    [playbackError],
  );

  /** Plays the first seconds of the result as it will sound, jumping over the cuts. */
  const previewResult = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || playbackError || kept.length === 0) return;
    setSkipCuts(true);
    previewEndRef.current = null;
    audio.currentTime = kept[0].start;
    void audio.play().catch(() => setPlaybackError(true));
  }, [kept, playbackError]);

  // ---------------------------------------------------------------- regions

  const sortRegions = (list: Region[]) => [...list].sort((a, b) => a.start - b.start);

  const createRegion = useCallback((start: number, end: number) => {
    const region: Region = { id: nextRegionId++, start, end };
    setRegions((prev) => sortRegions([...prev, region]));
    setSelectedId(region.id);
  }, []);

  const updateRegion = useCallback(
    (id: number, start: number, end: number) => {
      setRegions((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, auto: false, start: Math.max(0, Math.min(start, duration)), end: Math.max(0, Math.min(end, duration)) } : r,
        ),
      );
    },
    [duration],
  );

  const deleteRegion = useCallback((id: number) => {
    setRegions((prev) => prev.filter((r) => r.id !== id));
    setSelectedId((current) => (current === id ? null : current));
  }, []);

  const addRegionAtPlayhead = useCallback(() => {
    const start = Math.min(audioRef.current?.currentTime ?? 0, Math.max(0, duration - 1));
    createRegion(start, Math.min(start + 5, duration));
  }, [createRegion, duration]);

  // ---------------------------------------------------------------- silence detection

  const handleDetectSilence = useCallback(async () => {
    if (!file || !source || busyRef.current) return;
    setStage("detecting");
    setStageDetail("Đang tìm khoảng lặng…");
    setProgress(0);
    setErrorMessage(null);
    setNotice(null);
    busyRef.current = true;
    cancelledRef.current = false;
    try {
      const ffmpeg = await getFFmpeg(setStageDetail);
      const silences = await withInputFile(ffmpeg, file, (inputPath) =>
        detectSilences(ffmpeg, inputPath, source, duration, Number(silenceThreshold), Number(silenceLength), (f) =>
          setProgress(f * 100),
        ),
      );
      if (!mountedRef.current) return;
      const found: Region[] = silences
        .map((s) => ({
          // Silence at the very start or end is removed entirely; elsewhere a little is kept around the words.
          start: s.start <= 0.05 ? 0 : s.start + SILENCE_PADDING,
          end: s.end >= duration - 0.05 ? duration : s.end - SILENCE_PADDING,
        }))
        .filter((s) => s.end - s.start >= 0.1)
        .map((s) => ({ ...s, id: nextRegionId++, auto: true }));
      setMode("remove");
      setRegions((prev) => sortRegions([...prev.filter((r) => !r.auto), ...found]));
      setSelectedId(null);
      const removed = found.reduce((sum, r) => sum + r.end - r.start, 0);
      setNotice(
        found.length === 0
          ? "Không tìm thấy khoảng lặng nào. Thử chọn mức “Nhạy” hơn hoặc độ dài ngắn hơn."
          : `Đã đánh dấu ${found.length} khoảng lặng (tổng ${formatTimecode(removed, { fractional: false })}) để xóa. Bạn có thể chỉnh hoặc bỏ từng đoạn trước khi xuất.`,
      );
      setStage("ready");
    } catch (error) {
      if (!mountedRef.current) return;
      setStage("ready");
      if (cancelledRef.current || isTerminationError(error)) {
        setNotice("Đã hủy tìm khoảng lặng.");
        return;
      }
      console.error("[audio-trimmer] silence", error);
      setErrorMessage(describeError(error, "Không tìm được khoảng lặng."));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setStageDetail("");
        setProgress(0);
      }
    }
  }, [duration, file, silenceLength, silenceThreshold, source]);

  // ---------------------------------------------------------------- export

  const handleExport = useCallback(async () => {
    if (!file || !source || busyRef.current || kept.length === 0 || !regionsValid) return;
    const pieces = kept;
    const key = exportKey;
    const target = FORMATS[format];
    const outputPath = `/trimmed-${Date.now()}.${target.ext}`;
    audioRef.current?.pause();
    setResult(null);
    setStage("exporting");
    setStageDetail("Đang cắt và ghép âm thanh…");
    setProgress(0);
    setErrorMessage(null);
    setNotice(null);
    busyRef.current = true;
    cancelledRef.current = false;
    let engine: MediaEngine | null = null;
    try {
      const ffmpeg = await getFFmpeg(setStageDetail);
      engine = ffmpeg;
      const { graph, total } = buildFilter(pieces, source, duration, {
        fadeIn: Number(fadeIn),
        fadeOut: Number(fadeOut),
        smoothJoins,
      });
      await withInputFile(ffmpeg, file, (inputPath) =>
        execFFmpeg(
          ffmpeg,
          [
            "-i", inputPath,
            "-filter_complex", graph,
            "-map", "[out]",
            "-map_metadata", "0",
            ...codecArgs(format, quality, source),
            "-y", outputPath,
          ],
          { onTime: (seconds) => setProgress(Math.min(100, (seconds / total) * 100)) },
        ),
      );
      const blob = await takeOutputFile(ffmpeg, outputPath, target.mime);
      if (!mountedRef.current) return;
      const base = file.name.replace(/\.[^.]+$/, "") || "audio";
      setResult({ url: URL.createObjectURL(blob), name: `${base}_cut.${target.ext}`, size: blob.size, duration: total, key });
      setStage("ready");
    } catch (error) {
      if (engine) await engine.deleteFile(outputPath).catch(() => undefined);
      if (!mountedRef.current) return;
      setStage("ready");
      if (cancelledRef.current || isTerminationError(error)) {
        setNotice("Đã hủy xuất file.");
        return;
      }
      console.error("[audio-trimmer] export", error);
      setErrorMessage(describeError(error, "Đã có lỗi xảy ra khi xuất file."));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setStageDetail("");
        setProgress(0);
      }
    }
  }, [duration, exportKey, fadeIn, fadeOut, file, format, kept, quality, regionsValid, smoothJoins, source]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    terminateFFmpeg();
  }, []);

  // ---------------------------------------------------------------- render

  const removedTotal = duration - keptTotal;
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const canExport = loaded && !busy && kept.length > 0 && regionsValid;
  const regionNoun = mode === "remove" ? "cần xóa" : "cần giữ";

  const statusBadge =
    stage === "exporting" || stage === "detecting" || stage === "loading" ? (
      <Badge tone="attention">Đang xử lý</Badge>
    ) : stage === "error" ? (
      <Badge tone="critical">Lỗi</Badge>
    ) : result && !resultOutdated ? (
      <Badge tone="success">Đã xuất</Badge>
    ) : (
      <Badge>Sẵn sàng</Badge>
    );

  const statusText = !file
    ? "Thêm file âm thanh để bắt đầu."
    : !loaded
      ? "Không đọc được file này."
      : kept.length === 0
        ? mode === "keep"
          ? "Chọn ít nhất một đoạn cần giữ."
          : "Bạn đang xóa toàn bộ âm thanh."
        : !regionsValid
          ? "Có đoạn chưa hợp lệ, hãy kiểm tra lại thời gian."
          : regions.length === 0
            ? "Chưa chọn đoạn nào: file xuất ra sẽ giữ nguyên độ dài (chỉ áp dụng định dạng và hiệu ứng)."
            : "Sẵn sàng. Bấm “Xuất file” ở đầu trang.";

  return (
    <Page
      fullWidth
      backAction={{ content: "Tổng quan", url: "/" }}
      title="Cắt âm thanh"
      subtitle="Cắt bỏ những đoạn thừa trong file nhạc, ghi âm, podcast rồi xuất thành file mới. Xử lý ngay trên máy, không tải lên máy chủ."
      primaryAction={{ content: "Xuất file", onAction: handleExport, disabled: !canExport, loading: stage === "exporting" }}
      secondaryActions={file ? [{ content: "Gỡ file", destructive: true, onAction: clearFile, disabled: busy }] : undefined}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Âm thanh
                </Text>
                {!file ? (
                  <DropZone accept="audio/*,video/*" type="file" allowMultiple={false} onDrop={handleDrop} label="Âm thanh" labelHidden>
                    <DropZone.FileUpload
                      actionTitle="Chọn file âm thanh"
                      actionHint="MP3, M4A, WAV, FLAC, OGG, Opus, WMA… hoặc video (lấy phần âm thanh)"
                    />
                  </DropZone>
                ) : (
                  <BlockStack gap="300">
                    <BlockStack>
                      <Text as="p" fontWeight="semibold" breakWord>
                        {file.name}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {[formatBytes(file.size), loaded && formatTimecode(duration, { fractional: false })].filter(Boolean).join(" · ")}
                      </Text>
                    </BlockStack>

                    {audioUrl && (
                      <audio
                        ref={audioRef}
                        src={audioUrl}
                        preload="auto"
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onEnded={() => setPlaying(false)}
                        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                        onError={() => setPlaybackError(true)}
                        style={{ display: "none" }}
                      />
                    )}

                    {stage === "loading" && (
                      <BlockStack gap="200">
                        <ProgressBar progress={progress} size="small" tone="primary" />
                        <Text as="p" variant="bodySm" tone="subdued">
                          {stageDetail}
                        </Text>
                      </BlockStack>
                    )}

                    {loaded && (
                      <BlockStack gap="300">
                        <Waveform
                          peaks={peaks}
                          duration={duration}
                          regions={regions}
                          selectedId={selectedId}
                          kept={kept}
                          tone={mode}
                          zoom={zoom}
                          audioRef={audioRef}
                          disabled={busy}
                          onSeek={seek}
                          onSelect={setSelectedId}
                          onCreate={createRegion}
                          onUpdate={updateRegion}
                          onDelete={deleteRegion}
                          onTogglePlay={togglePlay}
                        />
                        <InlineStack align="space-between" blockAlign="center" gap="200">
                          <InlineStack gap="200" blockAlign="center">
                            <Button
                              icon={playing ? PauseCircleIcon : PlayIcon}
                              onClick={togglePlay}
                              disabled={playbackError}
                              accessibilityLabel={playing ? "Tạm dừng" : "Phát"}
                            />
                            <Tooltip content="Về đầu">
                              <Button icon={ReplayIcon} onClick={() => seek(0)} accessibilityLabel="Về đầu" />
                            </Tooltip>
                            <Text as="span" variant="bodyMd" numeric>
                              {formatTimecode(currentTime, { fractional: false })} / {formatTimecode(duration, { fractional: false })}
                            </Text>
                          </InlineStack>
                          <InlineStack gap="300" blockAlign="center">
                            <Checkbox
                              label="Nghe bỏ qua phần bị cắt"
                              checked={skipCuts}
                              onChange={setSkipCuts}
                            />
                            <ButtonGroup variant="segmented">
                              <Button
                                onClick={() => setZoom(ZOOM_LEVELS[Math.max(0, zoomIndex - 1)])}
                                disabled={zoomIndex <= 0}
                                accessibilityLabel="Thu nhỏ"
                              >
                                −
                              </Button>
                              <Button disabled>{`${zoom}×`}</Button>
                              <Button
                                onClick={() => setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, zoomIndex + 1)])}
                                disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
                                accessibilityLabel="Phóng to"
                              >
                                +
                              </Button>
                            </ButtonGroup>
                          </InlineStack>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Kéo chuột trên dạng sóng để chọn đoạn {regionNoun}; kéo mép để chỉnh, kéo giữa để di chuyển. Bấm để
                          nhảy tới vị trí đó. Phím tắt khi đang chọn dạng sóng: Space phát/dừng, ←/→ tua 1 giây (Shift: 5 giây),
                          Delete xóa đoạn đang chọn.
                        </Text>
                        {playbackError && (
                          <Banner tone="warning">
                            <p>Trình duyệt không phát được định dạng này nên không nghe thử được, nhưng vẫn cắt và xuất file bình thường.</p>
                          </Banner>
                        )}
                      </BlockStack>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {loaded && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Các đoạn {regionNoun} ({regions.length})
                    </Text>
                    <Button icon={PlusIcon} onClick={addRegionAtPlayhead} disabled={busy}>
                      Thêm đoạn
                    </Button>
                  </InlineStack>

                  {regions.length === 0 ? (
                    <Box paddingBlock="400">
                      <Text as="p" tone="subdued" alignment="center">
                        Chưa có đoạn nào. Kéo chuột trên dạng sóng, bấm “Thêm đoạn” hoặc dùng “Tự động xóa khoảng lặng”.
                      </Text>
                    </Box>
                  ) : (
                    <BlockStack gap="200">
                      {regions.map((region, index) => (
                        <div
                          key={region.id}
                          onFocusCapture={() => setSelectedId(region.id)}
                          style={{
                            borderRadius: "var(--p-border-radius-200)",
                            padding: "var(--p-space-200)",
                            background: region.id === selectedId ? "var(--p-color-bg-surface-selected)" : undefined,
                          }}
                        >
                          <InlineGrid columns={{ xs: "1fr", md: "40px 1fr 1fr auto" }} gap="300" alignItems="start">
                            <Box paddingBlockStart={{ xs: "0", md: "150" }}>
                              <Text as="span" fontWeight="semibold" tone="subdued">
                                #{index + 1}
                              </Text>
                            </Box>
                            <TimeField
                              label="Từ"
                              value={region.start}
                              disabled={busy}
                              onCommit={(seconds) => updateRegion(region.id, seconds, region.end)}
                              onPickCurrent={() => updateRegion(region.id, audioRef.current?.currentTime ?? 0, region.end)}
                            />
                            <TimeField
                              label="Đến"
                              value={region.end}
                              error={regionErrors.get(region.id)}
                              disabled={busy}
                              onCommit={(seconds) => updateRegion(region.id, region.start, seconds)}
                              onPickCurrent={() => updateRegion(region.id, region.start, audioRef.current?.currentTime ?? 0)}
                            />
                            <InlineStack gap="100" blockAlign="center" wrap={false}>
                              <Box minWidth="64px">
                                <Text as="span" variant="bodySm" tone="subdued" alignment="end">
                                  {region.end > region.start ? formatTimecode(region.end - region.start) : "--:--"}
                                </Text>
                              </Box>
                              {region.auto && <Badge size="small">Khoảng lặng</Badge>}
                              <Tooltip content="Nghe đoạn này">
                                <Button
                                  icon={PlayIcon}
                                  variant="tertiary"
                                  accessibilityLabel={`Nghe đoạn ${index + 1}`}
                                  onClick={() => previewRange(region.start, region.end)}
                                  disabled={playbackError || region.end <= region.start}
                                />
                              </Tooltip>
                              <Tooltip content="Bỏ đoạn này">
                                <Button
                                  icon={DeleteIcon}
                                  variant="tertiary"
                                  tone="critical"
                                  accessibilityLabel={`Bỏ đoạn ${index + 1}`}
                                  onClick={() => deleteRegion(region.id)}
                                  disabled={busy}
                                />
                              </Tooltip>
                            </InlineStack>
                          </InlineGrid>
                        </div>
                      ))}
                      <Divider />
                      <InlineStack align="space-between">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {regions.length} đoạn {regionNoun}
                        </Text>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => {
                            setRegions([]);
                            setSelectedId(null);
                          }}
                          disabled={busy}
                        >
                          Bỏ tất cả
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {result && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        File đã cắt
                      </Text>
                      {resultOutdated && <Badge tone="info">Đã chỉnh sửa sau khi xuất</Badge>}
                    </InlineStack>
                    <Button url={result.url} download={result.name} variant="primary">
                      Tải xuống
                    </Button>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {result.name} · {formatTimecode(result.duration, { fractional: false })} · {formatBytes(result.size)}
                  </Text>
                  <audio controls preload="metadata" src={result.url} style={{ width: "100%" }} />
                  {resultOutdated && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Bạn đã thay đổi đoạn cắt hoặc cài đặt. Bấm “Xuất file” để tạo lại.
                    </Text>
                  )}
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
                  Cách cắt
                </Text>
                <Select
                  label="Các đoạn đã chọn sẽ được"
                  options={MODE_OPTIONS}
                  value={mode}
                  onChange={(value) => setMode(value as Mode)}
                  disabled={busy}
                  helpText={
                    mode === "remove"
                      ? "Đánh dấu những đoạn thừa (đầu, cuối, đoạn nói vấp, quảng cáo…); phần còn lại được nối liền thành file mới."
                      : "Chỉ những đoạn được chọn được giữ lại và nối theo thứ tự thời gian."
                  }
                />
                {loaded && (
                  <BlockStack gap="100">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Độ dài gốc
                      </Text>
                      <Text as="span" variant="bodySm" numeric>
                        {formatTimecode(duration)}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Bị cắt bỏ
                      </Text>
                      <Text as="span" variant="bodySm" tone="critical" numeric>
                        −{formatTimecode(removedTotal)}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        Độ dài file mới
                      </Text>
                      <Text as="span" variant="bodySm" fontWeight="semibold" numeric>
                        {formatTimecode(keptTotal)}
                      </Text>
                    </InlineStack>
                    {kept.length > 1 && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Ghép từ {kept.length} phần.
                      </Text>
                    )}
                    <Box paddingBlockStart="100">
                      <Button onClick={previewResult} disabled={playbackError || kept.length === 0} fullWidth>
                        Nghe thử kết quả
                      </Button>
                    </Box>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Tự động xóa khoảng lặng
                </Text>
                <Select
                  label="Mức coi là im lặng"
                  options={SILENCE_THRESHOLD_OPTIONS}
                  value={silenceThreshold}
                  onChange={setSilenceThreshold}
                  disabled={busy}
                />
                <Select
                  label="Độ dài khoảng lặng"
                  options={SILENCE_LENGTH_OPTIONS}
                  value={silenceLength}
                  onChange={setSilenceLength}
                  disabled={busy}
                />
                <Button icon={MagicIcon} onClick={handleDetectSilence} disabled={!loaded || busy} loading={stage === "detecting"}>
                  Tìm và đánh dấu khoảng lặng
                </Button>
                <Text as="p" variant="bodySm" tone="subdued">
                  Hợp với ghi âm, podcast, bài giảng. Khoảng lặng ở đầu và cuối được xóa hết; ở giữa chừa lại{" "}
                  {SILENCE_PADDING.toLocaleString("vi-VN")} giây mỗi bên để không mất chữ. Chạy lại sẽ thay các khoảng lặng đã
                  đánh dấu trước đó.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Xuất file
                </Text>
                <Select
                  label="Định dạng"
                  options={FORMAT_OPTIONS}
                  value={format}
                  onChange={(value) => setFormat(value as OutFormat)}
                  disabled={busy}
                />
                {isLossy(format) && (
                  <Select
                    label="Chất lượng"
                    options={[
                      { label: `Cao · ${format === "ogg" ? "~" : ""}${BITRATES[format].high} kbps`, value: "high" },
                      { label: `Cân bằng · ${format === "ogg" ? "~" : ""}${BITRATES[format].balanced} kbps`, value: "balanced" },
                      { label: `Nhẹ · ${format === "ogg" ? "~" : ""}${BITRATES[format].small} kbps`, value: "small" },
                    ]}
                    value={quality}
                    onChange={(value) => setQuality(value as Quality)}
                    disabled={busy}
                  />
                )}
                <InlineGrid columns={2} gap="200">
                  <Select label="Fade in đầu bài" options={FADE_OPTIONS} value={fadeIn} onChange={setFadeIn} disabled={busy} />
                  <Select label="Fade out cuối bài" options={FADE_OPTIONS} value={fadeOut} onChange={setFadeOut} disabled={busy} />
                </InlineGrid>
                <Checkbox
                  label="Làm mượt điểm nối"
                  helpText="Thêm hiệu ứng chuyển rất ngắn ở mỗi chỗ cắt để không bị tiếng “tách”."
                  checked={smoothJoins}
                  onChange={setSmoothJoins}
                  disabled={busy}
                />
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
                {busy && stage !== "loading" ? (
                  <BlockStack gap="200">
                    <ProgressBar progress={progress} size="small" tone="primary" />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {stageDetail} {progress > 0 && `${Math.round(progress)}%`}
                    </Text>
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {stage === "loading" ? "Đang đọc file…" : statusText}
                  </Text>
                )}
                {busy && (
                  <InlineStack align="end">
                    <Button tone="critical" variant="plain" onClick={handleCancel}>
                      Hủy
                    </Button>
                  </InlineStack>
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
