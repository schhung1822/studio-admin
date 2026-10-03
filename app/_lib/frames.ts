"use client";

import { execFFmpeg, getFFmpeg, takeOutputFile, withInputFile } from "./ffmpeg";

const JPEG_QUALITY = 0.9;
const LOAD_TIMEOUT_MS = 15_000;
const SEEK_TIMEOUT_MS = 10_000;

interface CaptureOptions {
  /** Called as soon as each frame is ready, in order. */
  onFrame: (index: number, image: Blob) => void;
  onStage?: (message: string) => void;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Đã hủy.", "AbortError");
}

function waitForEvent(target: HTMLVideoElement, event: "loadeddata" | "seeked", timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onDone);
      target.removeEventListener("error", onError);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Trình duyệt không giải mã được video này."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Trình duyệt phản hồi quá lâu khi đọc video."));
    }, timeoutMs);
    target.addEventListener(event, onDone);
    target.addEventListener("error", onError);
  });
}

/**
 * Fast path: seek a hidden <video> and paint each frame to a canvas. Uses the browser's
 * (usually hardware) decoder, so it only costs one seek per frame.
 */
async function captureWithVideoElement(file: File, times: number[], { onFrame, signal }: CaptureOptions) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const loaded = waitForEvent(video, "loadeddata", LOAD_TIMEOUT_MS);
    video.src = url;
    await loaded;
    if (!video.videoWidth || !video.videoHeight) throw new Error("Video không có hình ảnh.");

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Trình duyệt không hỗ trợ canvas.");

    for (const [index, time] of times.entries()) {
      throwIfAborted(signal);
      const seeked = waitForEvent(video, "seeked", SEEK_TIMEOUT_MS);
      video.currentTime = time;
      await seeked;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
      if (!image) throw new Error("Không tạo được ảnh từ khung hình.");
      onFrame(index, image);
    }
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Fallback for codecs the browser cannot play (e.g. HEVC on some systems): one FFmpeg seek per frame. */
async function captureWithFFmpeg(file: File, times: number[], { onFrame, onStage, signal }: CaptureOptions) {
  const ffmpeg = await getFFmpeg(onStage);
  await withInputFile(ffmpeg, file, async (inputPath) => {
    for (const [index, time] of times.entries()) {
      throwIfAborted(signal);
      const outputPath = `/frame-${index}.jpg`;
      await execFFmpeg(ffmpeg, ["-ss", time.toFixed(3), "-i", inputPath, "-frames:v", "1", "-q:v", "2", "-y", outputPath]);
      onFrame(index, await takeOutputFile(ffmpeg, outputPath, "image/jpeg"));
    }
  });
}

/** Captures one JPEG per timestamp (seconds), trying the browser decoder first, then FFmpeg. */
export async function captureFrames(file: File, times: number[], options: CaptureOptions) {
  let captured = 0;
  const track: CaptureOptions = {
    ...options,
    onFrame: (index, image) => {
      captured = index + 1;
      options.onFrame(index, image);
    },
  };
  try {
    await captureWithVideoElement(file, times, track);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    console.warn("[frames] Browser capture failed, falling back to FFmpeg:", error);
    options.onStage?.("Trình duyệt không đọc được video, chuyển sang FFmpeg (chậm hơn)…");
    // Resume where the browser left off so finished frames are not redone.
    const remaining = times.slice(captured);
    const offset = captured;
    await captureWithFFmpeg(file, remaining, { ...options, onFrame: (index, image) => options.onFrame(index + offset, image) });
  }
}
