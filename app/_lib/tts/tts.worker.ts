/// <reference lib="webworker" />
// Runs Supertonic off the main thread: a single denoising pass on the CPU can take a second
// or more, which would otherwise freeze the page. Driven by app/_lib/tts/client.ts.
import { SupertonicTTS, type OrtModule, type SupertonicConfig, type SupertonicSessions } from "./supertonic";
import type { TtsBackend, WorkerRequest, WorkerResponse } from "./protocol";

// Loaded at runtime instead of bundled (same idea as the FFmpeg core in _lib/ffmpeg.ts): ORT
// locates its .wasm/.mjs files relative to its own URL, which bundling breaks. Keep the
// version in sync with the onnxruntime-web devDependency (used only for types).
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.min.mjs";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let tts: SupertonicTTS | null = null;

function post(message: WorkerResponse, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

function describe(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : "Lỗi không xác định.";
}

const MODEL_LABELS: Record<keyof SupertonicSessions, string> = {
  durationPredictor: "bộ dự đoán thời lượng",
  textEncoder: "bộ mã hóa văn bản",
  vectorEstimator: "bộ khử nhiễu",
  vocoder: "bộ tạo sóng âm",
};

async function createSessions(
  ort: OrtModule,
  models: Record<keyof SupertonicSessions, Uint8Array>,
  backend: Exclude<TtsBackend, "auto">,
) {
  const options = { executionProviders: [backend], graphOptimizationLevel: "all" as const };
  const sessions: Partial<SupertonicSessions> = {};
  const created: { release(): Promise<void> }[] = [];
  try {
    for (const key of Object.keys(MODEL_LABELS) as (keyof SupertonicSessions)[]) {
      post({ type: "init-progress", message: `Đang khởi tạo ${MODEL_LABELS[key]} (${backend === "webgpu" ? "GPU" : "CPU"})…` });
      const session = await ort.InferenceSession.create(models[key], options);
      created.push(session);
      sessions[key] = session;
    }
  } catch (error) {
    await Promise.allSettled(created.map((session) => session.release()));
    throw error;
  }
  return sessions as SupertonicSessions;
}

async function init(request: Extract<WorkerRequest, { type: "init" }>) {
  const ort = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ ORT_URL)) as OrtModule;
  ort.env.logLevel = "error";
  const cfg = JSON.parse(new TextDecoder().decode(request.config)) as SupertonicConfig;
  const indexer = JSON.parse(new TextDecoder().decode(request.indexer)) as number[];
  const models = {
    durationPredictor: new Uint8Array(request.models.duration_predictor),
    textEncoder: new Uint8Array(request.models.text_encoder),
    vectorEstimator: new Uint8Array(request.models.vector_estimator),
    vocoder: new Uint8Array(request.models.vocoder),
  };

  let backend: Exclude<TtsBackend, "auto"> = "wasm";
  let sessions: SupertonicSessions | null = null;
  if (request.backend === "auto" && "gpu" in navigator) {
    try {
      sessions = await createSessions(ort, models, "webgpu");
      backend = "webgpu";
    } catch (error) {
      console.warn("[tts] WebGPU unavailable, falling back to WebAssembly:", error);
    }
  }
  sessions ??= await createSessions(ort, models, "wasm");
  tts = new SupertonicTTS(ort, cfg, indexer, sessions);
  post({ type: "ready", backend, sampleRate: tts.sampleRate });
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "init") {
    try {
      await init(request);
    } catch (error) {
      post({ type: "init-error", message: describe(error) });
    }
    return;
  }

  const { id } = request;
  try {
    if (!tts) throw new Error("Mô hình chưa được tải.");
    const style = tts.createStyle(request.style);
    const startedAt = performance.now();
    const { wav, chunks } = await tts.synthesize(request.text, style, {
      ...request.options,
      onProgress: (done, total, chunk, chunkCount) => post({ type: "progress", id, done, total, chunk, chunks: chunkCount }),
    });
    post(
      { type: "result", id, wav, sampleRate: tts.sampleRate, chunks, elapsedMs: performance.now() - startedAt },
      [wav.buffer],
    );
  } catch (error) {
    post({ type: "error", id, message: describe(error) });
  }
};
