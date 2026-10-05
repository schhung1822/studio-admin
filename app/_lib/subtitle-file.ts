import { normalizeSearch } from "./format";
import { approximateWords, type SceneSpan, type TimedWord } from "./scenes";

// A reference word may sit this far outside a cue and still be matched to it, since an
// SRT's timings are often rounded or slightly offset from the speech.
const MATCH_WINDOW_SECONDS = 1;
// A word whose time falls outside every scene still joins the nearest one if it is this close.
const MAX_SCENE_DISTANCE_SECONDS = 1;

const TIMING_LINE =
  /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)/;

/** "00:01:02,5" / "01:02.500" -> seconds. */
function parseCueTime(text: string) {
  const [clock, fraction = ""] = text.split(/[,.]/);
  const seconds = clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return seconds + Number(`0.${fraction.padEnd(3, "0")}`);
}

/** Removes formatting like <i>, <font …> and ASS overrides such as {\an8}. */
function stripMarkup(text: string) {
  return text.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "");
}

/**
 * Reads SRT or WebVTT text (also when saved as .txt). Works line by line, so missing blank
 * lines between cues are tolerated. Throws if no timed cue is found.
 */
export function parseSubtitleFile(content: string): SceneSpan[] {
  const lines = content.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  const cues: { start: number; end: number; lines: string[] }[] = [];
  let current: (typeof cues)[number] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const timing = line.match(TIMING_LINE);
    if (timing) {
      current = { start: parseCueTime(timing[1]), end: parseCueTime(timing[2]), lines: [] };
      cues.push(current);
      continue;
    }
    if (!line || !current) continue;
    // A cue number belongs to the next cue, not to the text of this one.
    const nextLine = lines.slice(i + 1).find((l) => l.trim());
    if (/^\d+$/.test(line) && nextLine && TIMING_LINE.test(nextLine)) continue;
    current.lines.push(line);
  }

  const spans = cues
    .map((cue) => ({ start: cue.start, end: cue.end, text: stripMarkup(cue.lines.join(" ")).replace(/\s+/g, " ").trim() }))
    .filter((cue) => cue.text && cue.end > cue.start)
    .sort((a, b) => a.start - b.start);
  if (spans.length === 0) {
    throw new Error("Không tìm thấy câu phụ đề có mốc thời gian (dạng 00:00:01,000 --> 00:00:03,500) trong file.");
  }
  return spans;
}

/** Chinese/Japanese text is written without spaces, so its words are joined with "". */
export function joinerForText(text: string) {
  const cjk = (text.match(/[぀-ヿ㐀-鿿]/g) ?? []).length;
  const spaces = (text.match(/\s/g) ?? []).length;
  return cjk > 0 && spaces < cjk / 4 ? "" : " ";
}

const matchKey = (text: string) => normalizeSearch(text).replace(/[^\p{L}\p{N}]/gu, "");

/** Pairs of indices (a[i] === b[j]) forming a longest common subsequence. */
function matchSequences(a: string[], b: string[]): [number, number][] {
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] && a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] && a[i] === b[j]) pairs.push([i++, j++]);
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Shares [start, end] between words[from..to) in proportion to their length. */
function spread(words: TimedWord[], from: number, to: number, start: number, end: number) {
  const total = words.slice(from, to).reduce((sum, word) => sum + word.text.length, 0) || 1;
  let cursor = start;
  for (let k = from; k < to; k++) {
    const length = ((end - start) * words[k].text.length) / total;
    words[k] = { ...words[k], start: cursor, end: cursor + length };
    cursor += length;
  }
}

/**
 * Gives every word of the imported cues a time span. Each cue's own timing is kept; inside
 * a cue, words that also appear in the recognised speech (`reference`, e.g. Groq's word
 * timings) take its timing, and the remaining words share the gaps between them. Without
 * a reference, a cue's time is spread over its words by length.
 */
export function timeImportedWords(cues: SceneSpan[], reference: TimedWord[] | null, joiner: string): TimedWord[] {
  const ref = (reference ?? [])
    .filter((word) => word.end >= word.start)
    .map((word) => ({ ...word, key: matchKey(word.text) }))
    .sort((a, b) => a.start - b.start);

  return cues.flatMap((cue) => {
    const words = approximateWords([cue], joiner);
    if (ref.length === 0 || words.length === 0) return words;
    const nearby = ref.filter((word) => {
      const middle = (word.start + word.end) / 2;
      return middle >= cue.start - MATCH_WINDOW_SECONDS && middle <= cue.end + MATCH_WINDOW_SECONDS;
    });
    const anchors = matchSequences(
      words.map((word) => matchKey(word.text)),
      nearby.map((word) => word.key),
    );
    if (anchors.length === 0) return words;

    const clamp = (t: number) => Math.min(cue.end, Math.max(cue.start, t));
    const timed = [...words];
    let floor = cue.start;
    for (const [i, j] of anchors) {
      const start = Math.max(floor, clamp(nearby[j].start));
      const end = Math.max(start, clamp(nearby[j].end));
      timed[i] = { ...timed[i], start, end };
      floor = end;
    }
    let gapStart = cue.start;
    let from = 0;
    for (const [i] of [...anchors, [words.length]]) {
      const gapEnd = i < words.length ? timed[i].start : cue.end;
      spread(timed, from, i, gapStart, Math.max(gapStart, gapEnd));
      if (i < words.length) {
        gapStart = timed[i].end;
        from = i + 1;
      }
    }
    return timed;
  });
}

/**
 * Re-splits timed words into existing scenes: each word goes to the scene its middle falls
 * in (or the nearest one within a second). Returns one text per scene, in order.
 */
export function distributeToScenes(words: TimedWord[], scenes: { start: number; end: number }[], joiner: string) {
  const buckets = scenes.map(() => [] as string[]);
  let unassigned = 0;
  for (const word of words) {
    const middle = (word.start + word.end) / 2;
    let best = -1;
    let bestDistance = Infinity;
    scenes.forEach((scene, k) => {
      const distance = middle < scene.start ? scene.start - middle : middle >= scene.end ? middle - scene.end : 0;
      if (distance < bestDistance) {
        best = k;
        bestDistance = distance;
      }
    });
    if (best < 0 || bestDistance > MAX_SCENE_DISTANCE_SECONDS) unassigned++;
    else buckets[best].push(word.text.trim());
  }
  return { texts: buckets.map((bucket) => bucket.join(joiner).trim()), unassigned };
}
