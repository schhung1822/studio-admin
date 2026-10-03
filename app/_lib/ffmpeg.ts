"use client";

import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { getDesktop, type DesktopBridge } from "./desktop";

// Single-threaded core: no SharedArrayBuffer, so no COOP/COEP headers are needed.
const FFMPEG_CORE_BASE_URL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
// Unbundled copy of the @ffmpeg/ffmpeg worker, see scripts/copy-ffmpeg-worker.mjs.
const FFMPEG_WORKER_URL = "/ffmpeg/worker.js";

interface RunHandlers {
  onLog: (message: string) => void;
  /** Current output timestamp in seconds. */
  onTime: (seconds: number) => void;
}

/**
 * What the tools need from FFmpeg. In the browser this is ffmpeg.wasm; in the Windows app
 * it is the native ffmpeg.exe (multi-threaded, reads files straight from disk).
 */
export interface MediaEngine {
  readonly kind: "wasm" | "native";
  /** Makes `file` readable by FFmpeg for the duration of `run`, passing its path. */
  withInputFile<T>(file: File, run: (inputPath: string) => Promise<T>): Promise<T>;
  /** Resolves with FFmpeg's exit code; rejects if terminated or if the engine crashes. */
  run(args: string[], handlers: RunHandlers): Promise<number>;
  /** ffprobe's JSON report (format, streams, chapters) for a path. */
  probeJson(inputPath: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  deleteFile(path: string): Promise<void>;
  terminate(): void;
}

async function quietly(task: () => Promise<unknown>) {
  try {
    await task();
  } catch {
    // Cleanup is best-effort; the engine may already be terminated.
  }
}

class WasmEngine implements MediaEngine {
  readonly kind = "wasm" as const;
  constructor(private readonly ffmpeg: FFmpeg) {}

  /**
   * Mounts the file via WORKERFS so the video is read lazily instead of being copied into
   * wasm memory, falling back to an in-memory copy if mounting is unavailable.
   */
  async withInputFile<T>(file: File, run: (inputPath: string) => Promise<T>): Promise<T> {
    const { FFFSType } = await import("@ffmpeg/ffmpeg");
    const ffmpeg = this.ffmpeg;
    const mountDir = `/input-${Date.now()}`;
    let inputPath = `${mountDir}/${file.name}`;
    let mounted = false;
    let copied = false;
    try {
      try {
        await ffmpeg.createDir(mountDir);
        await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, mountDir);
        mounted = true;
      } catch {
        const { fetchFile } = await import("@ffmpeg/util");
        inputPath = `/input-copy-${Date.now()}`;
        await ffmpeg.writeFile(inputPath, await fetchFile(file));
        copied = true;
      }
      return await run(inputPath);
    } finally {
      if (copied) await quietly(() => ffmpeg.deleteFile(inputPath));
      if (mounted) await quietly(() => ffmpeg.unmount(mountDir));
      await quietly(() => ffmpeg.deleteDir(mountDir));
    }
  }

  async run(args: string[], { onLog, onTime }: RunHandlers) {
    const handleLog = ({ message }: { message: string }) => onLog(message);
    // ffmpeg.wasm reports `time` in microseconds.
    const handleProgress = ({ time }: { time: number }) => onTime(time / 1_000_000);
    this.ffmpeg.on("log", handleLog);
    this.ffmpeg.on("progress", handleProgress);
    try {
      return await this.ffmpeg.exec(args);
    } finally {
      this.ffmpeg.off("log", handleLog);
      this.ffmpeg.off("progress", handleProgress);
    }
  }

  async probeJson(inputPath: string) {
    const outputPath = `/probe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    try {
      // ffprobe's return code is unreliable in the wasm build; the JSON file is the source of truth.
      await this.ffmpeg.ffprobe([
        "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams", "-show_chapters",
        inputPath,
        "-o", outputPath,
      ]);
      const data = await this.ffmpeg.readFile(outputPath, "utf8");
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    } finally {
      await quietly(() => this.ffmpeg.deleteFile(outputPath));
    }
  }

  async readFile(path: string) {
    const data = await this.ffmpeg.readFile(path);
    return typeof data === "string" ? new TextEncoder().encode(data) : data;
  }

  async deleteFile(path: string) {
    await this.ffmpeg.deleteFile(path);
  }

  terminate() {
    this.ffmpeg.terminate();
  }
}

class NativeEngine implements MediaEngine {
  readonly kind = "native" as const;
  constructor(private readonly desktop: DesktopBridge) {}

  /** Files picked in the desktop app have a real path, so ffmpeg.exe reads them in place. */
  async withInputFile<T>(file: File, run: (inputPath: string) => Promise<T>): Promise<T> {
    const path = this.desktop.pathForFile(file);
    if (path) return run(path);
    const scratch = `/input-${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    await this.desktop.ffmpeg.writeFile(scratch, new Uint8Array(await file.arrayBuffer()));
    try {
      return await run(scratch);
    } finally {
      await quietly(() => this.desktop.ffmpeg.deleteFile(scratch));
    }
  }

  async run(args: string[], { onLog, onTime }: RunHandlers) {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const unsubscribe = this.desktop.ffmpeg.onEvent((event) => {
      if (event.jobId !== jobId) return;
      if (event.type === "log" && event.message !== undefined) onLog(event.message);
      if (event.type === "progress" && event.time !== undefined) onTime(event.time);
    });
    try {
      return await this.desktop.ffmpeg.exec(jobId, args);
    } finally {
      unsubscribe();
    }
  }

  probeJson(inputPath: string) {
    return this.desktop.ffmpeg.probe([
      "-v", "error",
      "-print_format", "json",
      "-show_format", "-show_streams", "-show_chapters",
      inputPath,
    ]);
  }

  readFile(path: string) {
    return this.desktop.ffmpeg.readFile(path);
  }

  deleteFile(path: string) {
    return this.desktop.ffmpeg.deleteFile(path);
  }

  terminate() {
    void this.desktop.ffmpeg.killAll();
  }
}

// One engine is shared by every tool. For wasm this means the ~30 MB core is only
// downloaded and compiled once per session, even when navigating between pages.
let instance: MediaEngine | null = null;
let loading: Promise<MediaEngine> | null = null;

export async function getFFmpeg(onStatus?: (message: string) => void): Promise<MediaEngine> {
  if (instance) return instance;
  const desktop = getDesktop();
  if (desktop) {
    instance = new NativeEngine(desktop);
    return instance;
  }
  if (!loading) {
    loading = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([import("@ffmpeg/ffmpeg"), import("@ffmpeg/util")]);
      const ffmpeg = new FFmpeg();
      onStatus?.("Đang tải FFmpeg (chỉ lần đầu, ~30 MB)…");
      const coreURL = await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript");
      const wasmURL = await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm");
      try {
        await ffmpeg.load({ coreURL, wasmURL, classWorkerURL: new URL(FFMPEG_WORKER_URL, window.location.origin).href });
      } finally {
        // The core is compiled once load() resolves, so the blob URLs are no longer needed.
        URL.revokeObjectURL(coreURL);
        URL.revokeObjectURL(wasmURL);
      }
      instance = new WasmEngine(ffmpeg);
      return instance;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/** True when running in the Windows app with native FFmpeg. */
export function isNativeEngine() {
  return getDesktop() !== null;
}

/**
 * Cancels any running command. For wasm this also frees the worker's memory; the next
 * getFFmpeg() loads a fresh one.
 */
export function terminateFFmpeg() {
  instance?.terminate();
  if (instance?.kind === "wasm") instance = null;
}

/** Makes `file` readable by FFmpeg for the duration of `run`. */
export function withInputFile<T>(engine: MediaEngine, file: File, run: (inputPath: string) => Promise<T>): Promise<T> {
  return engine.withInputFile(file, run);
}

export class FFmpegExecError extends Error {
  constructor(
    readonly exitCode: number,
    readonly logs: string[],
  ) {
    super(`FFmpeg lỗi (mã ${exitCode}). ${logs.slice(-3).join(" ")}`.trim());
    this.name = "FFmpegExecError";
  }
}

export class FFmpegCrashError extends Error {
  constructor(readonly detail: string) {
    super(
      /memory|out of bounds|abort/i.test(detail)
        ? "FFmpeg hết bộ nhớ hoặc bị lỗi khi xử lý file này. Hãy thử độ phân giải thấp hơn hoặc định dạng khác."
        : `FFmpeg bị lỗi: ${detail}`,
    );
    this.name = "FFmpegCrashError";
  }
}

/** Runs an FFmpeg command, reporting the output timestamp (in seconds) as it progresses. */
export async function execFFmpeg(
  engine: MediaEngine,
  args: string[],
  { onTime, onLog }: { onTime?: (seconds: number) => void; onLog?: (message: string) => void } = {},
) {
  const recentLogs: string[] = [];
  const handleLog = (message: string) => {
    recentLogs.push(message);
    if (recentLogs.length > 30) recentLogs.shift();
    onLog?.(message);
  };
  let exitCode: number;
  try {
    exitCode = await engine.run(args, { onLog: handleLog, onTime: (seconds) => onTime?.(seconds) });
  } catch (error) {
    if (isTerminationError(error)) throw error;
    // A wasm trap (e.g. "memory access out of bounds") leaves the core corrupted, so every
    // later command would fail too. Drop this worker; the next getFFmpeg() loads a fresh one.
    if (engine.kind === "wasm" && instance === engine) terminateFFmpeg();
    throw new FFmpegCrashError(describeError(error));
  }
  if (exitCode !== 0) throw new FFmpegExecError(exitCode, recentLogs);
}

/** Reads an output file as a Blob, then deletes it (frees wasm memory / temp disk space). */
export async function takeOutputFile(engine: MediaEngine, path: string, type: string): Promise<Blob> {
  try {
    const data = await engine.readFile(path);
    if (data.byteLength === 0) throw new Error("FFmpeg tạo ra file rỗng.");
    return new Blob([data.slice()], { type });
  } finally {
    await quietly(() => engine.deleteFile(path));
  }
}

/** The FFmpeg worker rejects with plain strings, so normalise anything thrown into a message. */
export function describeError(error: unknown, fallback = "Đã có lỗi xảy ra.") {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

export function isTerminationError(error: unknown) {
  return /terminate/i.test(describeError(error, ""));
}

export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  tags?: Record<string, string>;
  disposition?: { attached_pic?: number };
}

export interface ProbeResult {
  format?: { format_name?: string; duration?: string; tags?: Record<string, string> };
  streams?: ProbeStream[];
  chapters?: { id: number; tags?: Record<string, string> }[];
}

/** Runs ffprobe on a file and returns its JSON report. */
export async function probeMedia(engine: MediaEngine, inputPath: string): Promise<ProbeResult> {
  const text = await engine.probeJson(inputPath);
  if (!text.trim()) throw new Error("Không đọc được thông tin file.");
  return JSON.parse(text) as ProbeResult;
}

/** Parses "Duration: 00:12:34.56" from FFmpeg's input banner. */
export function parseDurationLog(message: string): number | null {
  const match = message.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}
