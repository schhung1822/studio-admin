import type { ProbeResult } from "./ffmpeg";

export interface MetadataEntry {
  /** Where the field lives, e.g. "File", "Video #0", "Chương 1". */
  scope: string;
  key: string;
  value: string;
  /** Could identify the device, person, place or time of recording. */
  sensitive: boolean;
}

// Fields every muxer writes to describe the container itself; they carry no personal data.
const STRUCTURAL_KEYS = new Set(["major_brand", "minor_version", "compatible_brands", "vendor_id", "language", "duration"]);
// Default handler names written by FFmpeg; anything else (e.g. "Core Media Video") hints at the source device/app.
const GENERIC_HANDLERS = new Set(["VideoHandler", "SoundHandler", "SubtitleHandler", "DataHandler", ""]);
// A bare "Lavf"/"Lavc" (no version) is what bitexact muxing leaves behind in Matroska/WebM.
// Matroska also tags re-encoded streams with e.g. "Lavc aac" — a codec name, no version.
const GENERIC_ENCODER = /^Lav[fc]( [\w-]+)?$/;
const VENDOR_ZERO = "[0][0][0][0]";

const STREAM_LABELS: Record<string, string> = {
  video: "Video",
  audio: "Âm thanh",
  subtitle: "Phụ đề",
  data: "Dữ liệu",
  attachment: "Đính kèm",
};

function isSensitive(key: string, value: string) {
  const lower = key.toLowerCase();
  if (STRUCTURAL_KEYS.has(lower)) return lower === "vendor_id" ? value !== VENDOR_ZERO && value !== "FFMP" : false;
  if (lower === "handler_name") return !GENERIC_HANDLERS.has(value);
  if (lower === "encoder") return !GENERIC_ENCODER.test(value);
  return true;
}

/** Flattens an ffprobe report into a list of metadata fields, flagging the identifying ones. */
export function listMetadata(probe: ProbeResult): MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  const push = (scope: string, tags: Record<string, string> | undefined) => {
    for (const [key, value] of Object.entries(tags ?? {})) {
      entries.push({ scope, key, value, sensitive: isSensitive(key, value) });
    }
  };

  push("File", probe.format?.tags);
  for (const stream of probe.streams ?? []) {
    const type = stream.codec_type ?? "data";
    const isCover = type === "video" && stream.disposition?.attached_pic === 1;
    const label = isCover ? "Ảnh bìa" : (STREAM_LABELS[type] ?? type);
    const scope = `${label} #${stream.index}`;
    if (isCover || type === "data" || type === "attachment") {
      // Whole tracks that are not picture or sound: timed GPS, camera telemetry, thumbnails…
      entries.push({
        scope,
        key: isCover ? "Ảnh bìa / thumbnail" : "Track phụ",
        value: stream.codec_name ?? "không rõ",
        sensitive: true,
      });
    }
    push(scope, stream.tags);
  }
  for (const [index, chapter] of (probe.chapters ?? []).entries()) {
    entries.push({ scope: `Chương ${index + 1}`, key: "chapter", value: chapter.tags?.title ?? "(không tên)", sensitive: true });
  }
  return entries;
}

// Signatures encoders leave inside the video bitstream (SEI), invisible to ffprobe's tags.
// Bare "Lavc"/"Lavf" without a version is the generic tag bitexact muxing keeps, so only
// versioned strings are reported.
const ENCODER_SIGNATURES: { pattern: RegExp; label: string }[] = [
  { pattern: /x264 - core \d+/, label: "Chuỗi cấu hình bộ mã hóa x264 (SEI)" },
  { pattern: /x265 \(build \d+/, label: "Chuỗi cấu hình bộ mã hóa x265 (SEI)" },
  { pattern: /Lavc\d+\.\d+\.\d+/, label: "Phiên bản FFmpeg (Lavc) trong luồng" },
];
const SIGNATURE_SCAN_BYTES = 8 * 1024 * 1024;

/** Looks for encoder signature strings near the start of a file (where they are written). */
export async function findEncoderSignatures(file: Blob): Promise<MetadataEntry[]> {
  const head = new Uint8Array(await file.slice(0, SIGNATURE_SCAN_BYTES).arrayBuffer());
  // latin1 maps bytes 1:1 to characters, so ASCII signatures can be matched directly.
  const text = new TextDecoder("latin1").decode(head);
  return ENCODER_SIGNATURES.flatMap(({ pattern, label }) => {
    const match = pattern.exec(text);
    if (!match) return [];
    const snippet = text.slice(match.index, match.index + 60).replace(/[^\x20-\x7e]+/g, " ").trim();
    return [{ scope: "Luồng hình/tiếng", key: label, value: snippet, sensitive: true }];
  });
}
