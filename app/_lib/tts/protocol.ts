// Messages between app/_lib/tts/client.ts (page) and app/_lib/tts/tts.worker.ts.
import type { SupertonicLang, VoiceStyleJson } from "./supertonic";

/** "auto" tries WebGPU first and falls back to WebAssembly (CPU). */
export type TtsBackend = "auto" | "webgpu" | "wasm";

export type ModelName = "duration_predictor" | "text_encoder" | "vector_estimator" | "vocoder";

export interface TtsOptions {
  lang: SupertonicLang;
  steps: number;
  speed: number;
  silenceSeconds: number;
}

export type WorkerRequest =
  | {
      type: "init";
      backend: TtsBackend;
      /** onnx/tts.json and onnx/unicode_indexer.json, as raw bytes. */
      config: ArrayBuffer;
      indexer: ArrayBuffer;
      models: Record<ModelName, ArrayBuffer>;
    }
  | { type: "synthesize"; id: number; text: string; style: VoiceStyleJson; options: TtsOptions };

export type WorkerResponse =
  | { type: "init-progress"; message: string }
  | { type: "ready"; backend: Exclude<TtsBackend, "auto">; sampleRate: number }
  | { type: "init-error"; message: string }
  | { type: "progress"; id: number; done: number; total: number; chunk: number; chunks: number }
  | { type: "result"; id: number; wav: Float32Array; sampleRate: number; chunks: number; elapsedMs: number }
  | { type: "error"; id: number; message: string };
