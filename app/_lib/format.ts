const pad = (n: number, width = 2) => n.toString().padStart(width, "0");

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 83.5 -> "01:23.5", 3725 -> "1:02:05". Milliseconds are only shown when present. */
export function formatTimecode(seconds: number, { fractional = true } = {}) {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (!fractional || ms === 0) return base;
  return `${base}.${pad(ms, 3).replace(/0+$/, "")}`;
}

/** Accepts "90", "1:30", "01:30.5", "1:02:03,25". Returns seconds, or null if malformed. */
export function parseTimecode(input: string): number | null {
  const cleaned = input.trim().replace(",", ".");
  if (!cleaned) return null;
  const parts = cleaned.split(":");
  if (parts.length > 3) return null;
  const valid = parts.every((part, i) => (i === parts.length - 1 ? /^\d+(\.\d+)?$/ : /^\d+$/).test(part));
  if (!valid) return null;
  const nums = parts.map(Number);
  if (parts.length >= 2 && nums[nums.length - 1] >= 60) return null;
  if (parts.length === 3 && nums[1] >= 60) return null;
  return nums.reduce((total, n) => total * 60 + n, 0);
}

/** Lowercase and strip Vietnamese diacritics so "cat" matches "Cắt". */
export function normalizeSearch(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  // Give the browser a moment to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function triggerDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
}
