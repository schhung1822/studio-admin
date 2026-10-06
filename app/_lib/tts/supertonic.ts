/**
 * Supertonic 3 text-to-speech pipeline (duration predictor → text encoder → flow-matching
 * vector estimator → vocoder), ported from the reference web example:
 * https://github.com/supertone-oss-archive/supertonic/blob/main/web/helper.js (MIT, © Supertone Inc.)
 *
 * The onnxruntime-web module is passed in rather than imported, so this file stays free of
 * runtime imports and can run in the worker that loads ORT from the CDN.
 */
import type * as Ort from "onnxruntime-web";

export type OrtModule = typeof Ort;

export const SUPERTONIC_LANGS = [
  "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu",
  "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na",
] as const;

export type SupertonicLang = (typeof SUPERTONIC_LANGS)[number];

/** Subset of onnx/tts.json used at inference time. */
export interface SupertonicConfig {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}

/** A voice_styles/*.json file. */
export interface VoiceStyleJson {
  style_ttl: { dims: number[]; data: unknown };
  style_dp: { dims: number[]; data: unknown };
}

export interface SupertonicSessions {
  durationPredictor: Ort.InferenceSession;
  textEncoder: Ort.InferenceSession;
  vectorEstimator: Ort.InferenceSession;
  vocoder: Ort.InferenceSession;
}

export interface SynthesisOptions {
  lang: SupertonicLang;
  /** Denoising steps: more is cleaner but slower (reference default 8). */
  steps: number;
  /** >1 speaks faster (reference default 1.05). */
  speed: number;
  /** Pause inserted between text chunks, in seconds. */
  silenceSeconds: number;
  /** Called after every model call; `done`/`total` count model calls across all chunks. */
  onProgress?: (done: number, total: number, chunk: number, chunks: number) => void;
}

const EMOJI_PATTERN =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

const SYMBOL_REPLACEMENTS: [string, string][] = [
  ["–", "-"],
  ["‑", "-"],
  ["—", "-"],
  ["_", " "],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["´", "'"],
  ["`", "'"],
  ["[", " "],
  ["]", " "],
  ["|", " "],
  ["/", " "],
  ["#", " "],
  ["→", " "],
  ["←", " "],
];

const EXPRESSION_REPLACEMENTS: [string, string][] = [
  ["@", " at "],
  ["e.g.,", "for example, "],
  ["i.e.,", "that is, "],
];

/** Same normalisation as the reference implementation, then wrapped in `<lang>…</lang>`. */
export function preprocessText(input: string, lang: SupertonicLang) {
  let text = input.normalize("NFKD").replace(EMOJI_PATTERN, "");
  for (const [from, to] of SYMBOL_REPLACEMENTS) text = text.replaceAll(from, to);
  text = text.replace(/[♥☆♡©\\]/g, "");
  for (const [from, to] of EXPRESSION_REPLACEMENTS) text = text.replaceAll(from, to);
  text = text.replace(/ ([,.!?;:'])/g, "$1");
  text = text.replace(/"{2,}/g, '"').replace(/'{2,}/g, "'");
  text = text.replace(/\s+/g, " ").trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(text)) text += ".";
  return `<${lang}>${text}</${lang}>`;
}

const SENTENCE_BOUNDARY =
  /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?。！？])\s+/;

/** Splits an over-long sentence at commas, then at spaces, so no chunk exceeds `maxLen`. */
function splitLongSentence(sentence: string, maxLen: number): string[] {
  if (sentence.length <= maxLen) return [sentence];
  for (const separator of [/(?<=[,;:，、])\s+/, /\s+/]) {
    const parts = sentence.split(separator);
    if (parts.length < 2) continue;
    const out: string[] = [];
    let current = "";
    for (const part of parts) {
      if (current && current.length + part.length + 1 > maxLen) {
        out.push(current);
        current = part;
      } else {
        current = current ? `${current} ${part}` : part;
      }
    }
    if (current) out.push(current);
    return out.flatMap((piece) => (piece.length > maxLen && piece !== sentence ? splitLongSentence(piece, maxLen) : [piece]));
  }
  // A single "word" longer than maxLen (no spaces at all): hard cut.
  const out: string[] = [];
  for (let i = 0; i < sentence.length; i += maxLen) out.push(sentence.slice(i, i + maxLen));
  return out;
}

/** Paragraphs (blank lines) → sentences → chunks of at most `maxLen` characters. */
export function chunkText(text: string, lang: SupertonicLang) {
  const maxLen = lang === "ko" || lang === "ja" ? 120 : 300;
  const chunks: string[] = [];
  for (const paragraph of text.trim().split(/\n\s*\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    let current = "";
    for (const sentence of trimmed.split(SENTENCE_BOUNDARY).flatMap((s) => splitLongSentence(s.trim(), maxLen))) {
      if (!sentence) continue;
      if (current && current.length + sentence.length + 1 > maxLen) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

/** Box–Muller standard normal sample. */
function gaussian() {
  const u1 = Math.max(1e-4, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export class SupertonicTTS {
  readonly sampleRate: number;

  constructor(
    private readonly ort: OrtModule,
    private readonly cfg: SupertonicConfig,
    /** unicode_indexer.json: code point → token id (-1 = unknown). */
    private readonly indexer: ArrayLike<number>,
    private readonly sessions: SupertonicSessions,
  ) {
    this.sampleRate = cfg.ae.sample_rate;
  }

  /** Builds the [1, …] style tensors from a voice_styles/*.json file. */
  createStyle(json: VoiceStyleJson) {
    const toTensor = ({ dims, data }: { dims: number[]; data: unknown }) => {
      const flat = Float32Array.from((data as unknown[]).flat(Infinity) as number[]);
      if (dims[0] !== 1) throw new Error("File giọng phải chứa đúng một giọng.");
      return new this.ort.Tensor("float32", flat, dims);
    };
    return { ttl: toTensor(json.style_ttl), dp: toTensor(json.style_dp) };
  }

  /** Synthesises `text` chunk by chunk and joins the chunks with short pauses. */
  async synthesize(text: string, style: ReturnType<SupertonicTTS["createStyle"]>, options: SynthesisOptions) {
    const chunks = chunkText(text, options.lang);
    if (chunks.length === 0) throw new Error("Chưa có nội dung để đọc.");
    // Per chunk: duration predictor + text encoder + `steps` denoising passes + vocoder.
    const callsPerChunk = options.steps + 3;
    const totalCalls = chunks.length * callsPerChunk;
    const pieces: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const base = i * callsPerChunk;
      const wav = await this.inferChunk(chunks[i], style, options, (done) =>
        options.onProgress?.(base + done, totalCalls, i + 1, chunks.length),
      );
      pieces.push(wav);
    }
    const silence = Math.floor(options.silenceSeconds * this.sampleRate);
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0) + silence * (pieces.length - 1);
    const out = new Float32Array(total);
    let offset = 0;
    pieces.forEach((piece, index) => {
      if (index > 0) offset += silence;
      out.set(piece, offset);
      offset += piece.length;
    });
    return { wav: out, chunks: chunks.length };
  }

  private async inferChunk(
    text: string,
    style: ReturnType<SupertonicTTS["createStyle"]>,
    { lang, steps, speed }: SynthesisOptions,
    onCall: (done: number) => void,
  ) {
    const { Tensor } = this.ort;
    const { durationPredictor, textEncoder, vectorEstimator, vocoder } = this.sessions;

    const processed = preprocessText(text, lang);
    const codePoints = Array.from(processed, (char) => char.codePointAt(0)!);
    const ids = new BigInt64Array(codePoints.length);
    codePoints.forEach((cp, i) => {
      ids[i] = BigInt(cp < this.indexer.length ? this.indexer[cp] : -1);
    });
    const textIds = new Tensor("int64", ids, [1, ids.length]);
    const textMask = new Tensor("float32", new Float32Array(ids.length).fill(1), [1, 1, ids.length]);

    const { duration } = await durationPredictor.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    onCall(1);
    const seconds = (duration.data as Float32Array)[0] / speed;

    const { text_emb: textEmb } = await textEncoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
    onCall(2);

    const chunkSize = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor;
    const latentDim = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor;
    const latentLen = Math.max(1, Math.ceil(Math.floor(seconds * this.sampleRate) / chunkSize));
    let latent: Float32Array = new Float32Array(latentDim * latentLen);
    for (let i = 0; i < latent.length; i++) latent[i] = gaussian();
    const latentMask = new Tensor("float32", new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
    const totalStep = new Tensor("float32", new Float32Array([steps]), [1]);

    for (let step = 0; step < steps; step++) {
      const outputs = await vectorEstimator.run({
        noisy_latent: new Tensor("float32", latent, [1, latentDim, latentLen]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new Tensor("float32", new Float32Array([step]), [1]),
        total_step: totalStep,
      });
      latent = outputs.denoised_latent.data as Float32Array;
      onCall(3 + step);
    }

    const { wav_tts: wav } = await vocoder.run({ latent: new Tensor("float32", latent, [1, latentDim, latentLen]) });
    onCall(3 + steps);
    // The vocoder pads to whole latent chunks; trim to the predicted duration.
    const samples = wav.data as Float32Array;
    const length = Math.min(samples.length, Math.floor(seconds * this.sampleRate));
    return samples.slice(0, length);
  }
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
