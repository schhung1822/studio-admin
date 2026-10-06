"use client";

import { getDesktop } from "../desktop";
import type { ModelName, TtsBackend, TtsOptions, WorkerRequest, WorkerResponse } from "./protocol";
import type { VoiceStyleJson } from "./supertonic";

export type { TtsBackend, TtsOptions } from "./protocol";

// Supertonic 3 assets on Hugging Face, pinned to the archived snapshot used by the reference repo.
const MODEL_REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46";
const MODEL_BASE_URL = `https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/${MODEL_REVISION}`;
const CACHE_NAME = `supertonic-3-${MODEL_REVISION.slice(0, 8)}`;

/** Files needed before the first synthesis, with their sizes for the progress bar. */
const CORE_ASSETS = [
  { path: "onnx/tts.json", size: 8_253 },
  { path: "onnx/unicode_indexer.json", size: 277_676 },
  { path: "onnx/duration_predictor.onnx", size: 3_700_147 },
  { path: "onnx/text_encoder.onnx", size: 36_416_150 },
  { path: "onnx/vector_estimator.onnx", size: 256_534_781 },
  { path: "onnx/vocoder.onnx", size: 101_424_195 },
] as const;

export const MODEL_DOWNLOAD_BYTES = CORE_ASSETS.reduce((sum, asset) => sum + asset.size, 0);

export const VOICES = [
  { value: "M1", label: "Nam 1" },
  { value: "M2", label: "Nam 2" },
  { value: "M3", label: "Nam 3" },
  { value: "M4", label: "Nam 4" },
  { value: "M5", label: "Nam 5" },
  { value: "F1", label: "Nữ 1" },
  { value: "F2", label: "Nữ 2" },
  { value: "F3", label: "Nữ 3" },
  { value: "F4", label: "Nữ 4" },
  { value: "F5", label: "Nữ 5" },
] as const;

export type VoiceId = (typeof VOICES)[number]["value"];

// ---------------------------------------------------------------- asset storage

/**
 * Where downloaded model files are kept. The browser uses Cache Storage; the Windows app
 * serves the UI from a new localhost port on every launch (a new origin, so an empty cache),
 * which is why it keeps the files in %APPDATA% through the desktop bridge instead.
 */
interface AssetStore {
  read(path: string): Promise<ArrayBuffer | null>;
  write(path: string, data: ArrayBuffer): Promise<void>;
  has(paths: readonly string[]): Promise<boolean>;
  clear(): Promise<void>;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? (data.buffer as ArrayBuffer)
    : (data.slice().buffer as ArrayBuffer);
}

function getAssetStore(): AssetStore | null {
  const models = getDesktop()?.models;
  if (models) {
    const key = (path: string) => `${CACHE_NAME}/${path}`;
    return {
      read: async (path) => {
        const data = await models.read(key(path));
        return data ? toArrayBuffer(data) : null;
      },
      write: (path, data) => models.write(key(path), new Uint8Array(data)),
      has: (paths) => models.has(paths.map(key)),
      clear: () => models.clear(),
    };
  }
  if (typeof caches === "undefined") return null;
  const url = (path: string) => `${MODEL_BASE_URL}/${path}`;
  return {
    read: async (path) => {
      const response = await (await caches.open(CACHE_NAME)).match(url(path));
      return response ? response.arrayBuffer() : null;
    },
    write: async (path, data) => {
      await (await caches.open(CACHE_NAME)).put(url(path), new Response(data));
    },
    has: async (paths) => {
      const cache = await caches.open(CACHE_NAME);
      const hits = await Promise.all(paths.map((path) => cache.match(url(path))));
      return hits.every(Boolean);
    },
    clear: async () => {
      for (const name of await caches.keys()) if (name.startsWith("supertonic-")) await caches.delete(name);
    },
  };
}

async function download(path: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(`${MODEL_BASE_URL}/${path}`, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Không kết nối được tới Hugging Face để tải mô hình. Hãy kiểm tra kết nối mạng.");
  }
  if (!response.ok || !response.body) throw new Error(`Tải ${path} thất bại (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    onBytes(value.byteLength);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

/** Reads an asset from storage, downloading (and storing) it on a miss. */
async function loadAsset(store: AssetStore | null, path: string, signal: AbortSignal, onBytes: (bytes: number) => void) {
  const cached = await store?.read(path).catch(() => null);
  if (cached) {
    onBytes(cached.byteLength);
    return cached;
  }
  const data = await download(path, signal, onBytes);
  // Storing is best-effort (e.g. quota exceeded): synthesis still works, it just re-downloads next time.
  await store?.write(path, data).catch((error) => console.warn(`[tts] Could not cache ${path}:`, error instanceof Error ? `${error.name}: ${error.message}` : error));
  return data;
}

/** True when every model file is already stored locally (no download needed). */
export async function isModelDownloaded() {
  try {
    return (await getAssetStore()?.has(CORE_ASSETS.map((asset) => asset.path))) ?? false;
  } catch {
    return false;
  }
}

/** Deletes the stored model files (~400 MB). Also unloads the running engine. */
export async function clearModelCache() {
  terminateTts();
  voiceCache.clear();
  await getAssetStore()?.clear();
}

const voiceCache = new Map<VoiceId, Promise<VoiceStyleJson>>();

function loadVoice(voice: VoiceId) {
  let pending = voiceCache.get(voice);
  if (!pending) {
    pending = (async () => {
      const data = await loadAsset(getAssetStore(), `voice_styles/${voice}.json`, new AbortController().signal, () => {});
      return JSON.parse(new TextDecoder().decode(data)) as VoiceStyleJson;
    })();
    pending.catch(() => voiceCache.delete(voice));
    voiceCache.set(voice, pending);
  }
  return pending;
}

// ---------------------------------------------------------------- engine

export type TtsLoadStatus =
  | { stage: "download"; loaded: number; total: number; cached: boolean }
  | { stage: "init"; message: string };

export interface SynthesisProgress {
  /** 0–100 across all chunks. */
  percent: number;
  chunk: number;
  chunks: number;
}

export interface SynthesisResult {
  wav: Float32Array;
  sampleRate: number;
  chunks: number;
  elapsedMs: number;
}

export interface TtsEngine {
  /** The backend that was asked for ("auto" may resolve to either). */
  readonly requested: TtsBackend;
  readonly backend: Exclude<TtsBackend, "auto">;
  synthesize(
    text: string,
    voice: VoiceId,
    options: TtsOptions,
    onProgress?: (progress: SynthesisProgress) => void,
  ): Promise<SynthesisResult>;
}

interface Pending {
  resolve(result: SynthesisResult): void;
  reject(error: Error): void;
  onProgress?: (progress: SynthesisProgress) => void;
}

class WorkerEngine implements TtsEngine {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly worker: Worker,
    readonly requested: TtsBackend,
    readonly backend: Exclude<TtsBackend, "auto">,
  ) {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error("Bộ tạo giọng nói bị lỗi (có thể do thiếu bộ nhớ). Hãy thử văn bản ngắn hơn hoặc chọn bộ xử lý CPU."));
    };
  }

  private handle(message: WorkerResponse) {
    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "progress") {
      pending.onProgress?.({ percent: (message.done / message.total) * 100, chunk: message.chunk, chunks: message.chunks });
    } else if (message.type === "result") {
      this.pending.delete(message.id);
      pending.resolve(message);
    } else if (message.type === "error") {
      this.pending.delete(message.id);
      pending.reject(new Error(message.message));
    }
  }

  /** Rejects every in-flight request and drops this engine (a crashed worker cannot be reused). */
  fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker.terminate();
    if (engine === this) engine = null;
  }

  async synthesize(text: string, voice: VoiceId, options: TtsOptions, onProgress?: (progress: SynthesisProgress) => void) {
    const style = await loadVoice(voice);
    const id = this.nextId++;
    return new Promise<SynthesisResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: "synthesize", id, text, style, options } satisfies WorkerRequest);
    });
  }
}

// One engine is shared by every visit to the page: the models (~400 MB) are only read and
// compiled once per session.
let engine: WorkerEngine | null = null;
let loading: {
  backend: TtsBackend;
  promise: Promise<WorkerEngine>;
  abort: AbortController;
  onStatus?: (status: TtsLoadStatus) => void;
} | null = null;

export class TtsCancelledError extends Error {
  constructor() {
    super("Đã hủy.");
    this.name = "TtsCancelledError";
  }
}

async function startEngine(backend: TtsBackend, signal: AbortSignal, report: (status: TtsLoadStatus) => void) {
  const store = getAssetStore();
  const cached = await isModelDownloaded();
  if (store && typeof navigator !== "undefined") void navigator.storage?.persist?.().catch(() => false);

  let loaded = 0;
  const onBytes = (bytes: number) => {
    loaded += bytes;
    report({ stage: "download", loaded, total: MODEL_DOWNLOAD_BYTES, cached });
  };
  report({ stage: "download", loaded: 0, total: MODEL_DOWNLOAD_BYTES, cached });
  const files: Record<string, ArrayBuffer> = {};
  for (const asset of CORE_ASSETS) {
    files[asset.path] = await loadAsset(store, asset.path, signal, onBytes);
    if (signal.aborted) throw new TtsCancelledError();
  }

  report({ stage: "init", message: "Đang khởi động bộ tạo giọng nói…" });
  const worker = new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module" });
  const models: Record<ModelName, ArrayBuffer> = {
    duration_predictor: files["onnx/duration_predictor.onnx"],
    text_encoder: files["onnx/text_encoder.onnx"],
    vector_estimator: files["onnx/vector_estimator.onnx"],
    vocoder: files["onnx/vocoder.onnx"],
  };
  const ready = await new Promise<Extract<WorkerResponse, { type: "ready" }>>((resolve, reject) => {
    const onAbort = () => reject(new TtsCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "init-progress") report({ stage: "init", message: message.message });
      else if (message.type === "ready") resolve(message);
      else if (message.type === "init-error") reject(new Error(`Không khởi tạo được mô hình: ${message.message}`));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      reject(new Error(event.message || "Không chạy được bộ tạo giọng nói trong trình duyệt này."));
    };
    worker.postMessage(
      {
        type: "init",
        backend,
        config: files["onnx/tts.json"],
        indexer: files["onnx/unicode_indexer.json"],
        models,
      } satisfies WorkerRequest,
      Object.values(models),
    );
  }).catch((error) => {
    worker.terminate();
    throw error;
  });
  return new WorkerEngine(worker, backend, ready.backend);
}

/**
 * Returns the shared engine, downloading the models on first use. Asking for a different
 * backend than the loaded one restarts the worker.
 */
export function getTtsEngine(backend: TtsBackend, onStatus?: (status: TtsLoadStatus) => void): Promise<TtsEngine> {
  if (engine && engine.requested === backend) return Promise.resolve(engine);
  if (loading && loading.backend === backend) {
    loading.onStatus = onStatus;
    return loading.promise;
  }
  terminateTts();
  const abort = new AbortController();
  const state = {
    backend,
    abort,
    onStatus,
    promise: null as unknown as Promise<WorkerEngine>,
  };
  state.promise = startEngine(backend, abort.signal, (status) => state.onStatus?.(status))
    .then((created) => {
      if (abort.signal.aborted) {
        created.fail(new TtsCancelledError());
        throw new TtsCancelledError();
      }
      engine = created;
      return created;
    })
    .catch((error) => {
      throw abort.signal.aborted ? new TtsCancelledError() : error;
    })
    .finally(() => {
      if (loading === state) loading = null;
    });
  loading = state;
  return state.promise;
}

/** Stops any download or synthesis in progress and frees the models' memory. */
export function terminateTts() {
  loading?.abort.abort();
  loading = null;
  engine?.fail(new TtsCancelledError());
  engine = null;
}

/** The backend of the currently loaded engine, if any. */
export function loadedTtsBackend() {
  return engine?.backend ?? null;
}
