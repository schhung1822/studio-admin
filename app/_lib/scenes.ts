/** A word (or CJK token) with its time span in seconds. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface SceneSpan {
  start: number;
  end: number;
  text: string;
}

export interface SceneOptions {
  minDuration: number;
  maxDuration: number;
  /** Total media length, so scenes can be stretched into trailing silence. */
  mediaDuration?: number | null;
  /** How words are joined back into text ("" for Chinese/Japanese). */
  joiner?: string;
}

// A pause longer than this is treated as a hard break: no scene spans across it.
const HARD_PAUSE_SECONDS = 1.2;
// How much of a pause is kept around speech when a scene does not need stretching.
const EDGE_PADDING_SECONDS = 0.15;
// Cost per second a scene falls outside [min, max]; dominates every other preference.
const OUT_OF_RANGE_COST = 100;
// Upper bound on how far back the optimiser looks when forming one scene.
const MAX_WORDS_PER_SCENE = 80;

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
const CLAUSE_END = /[,;:，、；：–—]["'”’)\]]*$/;
// Whisper sometimes drops the space after a full stop: "channel.Today".
const GLUED_SENTENCES = /(?<=\p{Ll})([.!?…])(?=\p{Lu})/u;

/** Languages written without spaces between words. */
export function wordJoinerFor(language: string) {
  return language === "zh" || language === "ja" ? "" : " ";
}

/**
 * Fallback when only segment-level timestamps exist (e.g. Whisper's translate mode):
 * split each segment into words and spread its duration by character count.
 */
export function approximateWords(segments: SceneSpan[], joiner = " "): TimedWord[] {
  const words: TimedWord[] = [];
  for (const segment of segments) {
    const tokens = joiner === "" ? Array.from(segment.text.replace(/\s+/g, "")) : segment.text.split(/\s+/).filter(Boolean);
    const totalChars = tokens.reduce((sum, token) => sum + token.length, 0) || 1;
    let cursor = segment.start;
    for (const token of tokens) {
      const length = ((segment.end - segment.start) * token.length) / totalChars;
      words.push({ text: token, start: cursor, end: cursor + length });
      cursor += length;
    }
  }
  return words;
}

/** Splits "channel.Today" into "channel." + "Today", sharing the time by length. */
function splitGluedWords(words: TimedWord[]): TimedWord[] {
  return words.flatMap((word) => {
    const parts = word.text.split(GLUED_SENTENCES);
    if (parts.length === 1) return [word];
    // split() with a capture group interleaves the punctuation; re-attach it to the left part.
    const pieces: string[] = [];
    for (let i = 0; i < parts.length; i += 2) pieces.push(parts[i] + (parts[i + 1] ?? ""));
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
    let cursor = word.start;
    return pieces.map((piece) => {
      const length = ((word.end - word.start) * piece.length) / total;
      const result = { text: piece, start: cursor, end: cursor + length };
      cursor += length;
      return result;
    });
  });
}

/** Longest plausible spoken length of a token; digits are read out as whole words. */
function maxWordSeconds(text: string) {
  const digits = (text.match(/\d/g) ?? []).length;
  const letters = Array.from(text.replace(/[\d\p{P}\s]/gu, "")).length;
  return 0.5 + 0.15 * letters + 0.4 * digits;
}

/**
 * Whisper's word timings often swallow a preceding pause into the next word
 * (e.g. "The" lasting 2.5 s) or overlap neighbours. Remove overlaps and trim
 * implausibly long words from the front, returning that time to the pause.
 */
function normalizeTimings(words: TimedWord[]): TimedWord[] {
  const result: TimedWord[] = [];
  for (const word of words) {
    const prevEnd = result.length > 0 ? result[result.length - 1].end : 0;
    const end = Math.max(word.end, prevEnd);
    const start = Math.max(word.start, prevEnd, end - maxWordSeconds(word.text));
    result.push({ ...word, start, end });
  }
  return result;
}

/** How good a place "right after this word" is to end a scene. */
function boundaryScore(word: TimedWord, next: TimedWord | undefined) {
  if (!next) return 3;
  const pause = Math.max(0, next.start - word.end);
  if (SENTENCE_END.test(word.text)) return 3 + Math.min(1, pause);
  if (CLAUSE_END.test(word.text)) return 2 + Math.min(1, pause);
  return Math.min(1.5, pause * 2);
}

/**
 * Groups timed words into scenes whose length falls within [minDuration, maxDuration].
 *
 * The cut points are chosen together (dynamic programming) to minimise: time outside the
 * allowed range (heavily), then poor cut positions — sentence ends are best, then
 * commas/clauses, then pauses — then distance from the middle of the range. Long pauses
 * always end a scene. Short scenes next to silence are stretched into it afterwards.
 */
export function buildScenes(words: TimedWord[], options: SceneOptions): SceneSpan[] {
  const { minDuration, maxDuration, mediaDuration = null } = options;
  const joiner = options.joiner ?? " ";
  const target = (minDuration + maxDuration) / 2;
  const range = Math.max(0.1, maxDuration - minDuration);
  const w = normalizeTimings(
    splitGluedWords(
      words
        .map((word) => ({ ...word, text: word.text.trim() }))
        .filter((word) => word.text && word.end >= word.start)
        .sort((a, b) => a.start - b.start),
    ),
  );
  const n = w.length;
  if (n === 0) return [];
  const mediaEnd = mediaDuration ?? w[n - 1].end + EDGE_PADDING_SECONDS;

  const gapAfter = (j: number) => (j + 1 < n ? Math.max(0, w[j + 1].start - w[j].end) : 0);
  const hardAfter = (j: number) => j + 1 < n && gapAfter(j) > HARD_PAUSE_SECONDS;
  // Where a scene ending after word j stops, and where the following scene begins.
  const cutAfter = (j: number) => {
    if (j === n - 1) return { end: w[j].end + Math.min(EDGE_PADDING_SECONDS, Math.max(0, mediaEnd - w[j].end)), nextStart: 0 };
    if (!hardAfter(j)) {
      const middle = w[j].end + gapAfter(j) / 2;
      return { end: middle, nextStart: middle };
    }
    return { end: w[j].end + EDGE_PADDING_SECONDS, nextStart: w[j + 1].start - EDGE_PADDING_SECONDS };
  };
  const sceneStart = (a: number) => (a === 0 ? Math.max(0, w[0].start - EDGE_PADDING_SECONDS) : cutAfter(a - 1).nextStart);
  // Silence a scene could later be stretched into. Any pause can host the cut anywhere
  // inside it, so each side may claim up to half of it.
  const shareOfPause = (j: number) => Math.max(0, gapAfter(j) - 2 * EDGE_PADDING_SECONDS) / 2;
  const roomBefore = (a: number) => (a === 0 ? sceneStart(0) : shareOfPause(a - 1));
  const roomAfter = (b: number) => (b === n - 1 ? Math.max(0, mediaEnd - cutAfter(b).end) : shareOfPause(b));

  const sceneCost = (a: number, b: number) => {
    const duration = cutAfter(b).end - sceneStart(a);
    const stretchable = duration + roomBefore(a) + roomAfter(b);
    let cost = 0;
    if (duration > maxDuration) cost += (duration - maxDuration) * OUT_OF_RANGE_COST;
    else if (stretchable < minDuration) cost += (minDuration - stretchable) * OUT_OF_RANGE_COST;
    const effective = Math.max(duration, Math.min(minDuration, stretchable));
    cost += Math.abs(effective - target) / range;
    return cost - boundaryScore(w[b], w[b + 1]);
  };

  // best[i + 1] = cheapest way to split words 0..i; from[i + 1] = first word of the last scene.
  const best = new Array<number>(n + 1).fill(Infinity);
  const from = new Array<number>(n + 1).fill(0);
  best[0] = 0;
  for (let b = 0; b < n; b++) {
    for (let a = b; a >= 0 && b - a < MAX_WORDS_PER_SCENE; a--) {
      if (a < b && hardAfter(a)) break; // a scene never spans a long pause
      const cost = best[a] + sceneCost(a, b);
      if (cost < best[b + 1]) {
        best[b + 1] = cost;
        from[b + 1] = a;
      }
    }
  }
  const groups: { first: number; last: number; start: number; end: number }[] = [];
  for (let end = n; end > 0; end = from[end]) {
    const first = from[end];
    groups.unshift({ first, last: end - 1, start: sceneStart(first), end: cutAfter(end - 1).end });
  }

  // Stretch short scenes into the silence around them. A boundary may move anywhere inside
  // a pause (never into speech), as long as the neighbour keeps at least minDuration.
  const SPEECH_GUARD = 0.05;
  const missing = (k: number) => Math.max(0, minDuration - (groups[k].end - groups[k].start));
  for (let k = 0; k < groups.length; k++) {
    const group = groups[k];
    let need = missing(k);
    if (need === 0) continue;

    const next = groups[k + 1];
    if (next) {
      const speechLimit = w[next.first].start - SPEECH_GUARD;
      const freeUntil = next.start - Math.min(missing(k + 1), (next.start - group.end) / 2);
      const allowedEnd = Math.min(speechLimit, Math.max(freeUntil, next.end - minDuration));
      const newEnd = Math.max(group.end, Math.min(group.end + need, allowedEnd));
      need -= newEnd - group.end;
      group.end = newEnd;
      if (next.start < newEnd) next.start = newEnd;
    } else {
      const newEnd = Math.min(group.end + need, mediaEnd);
      need -= newEnd - group.end;
      group.end = newEnd;
    }

    const prev = groups[k - 1];
    if (need > 0) {
      const speechLimit = prev ? w[prev.last].end + SPEECH_GUARD : 0;
      const allowedStart = prev ? Math.max(speechLimit, Math.min(prev.end, prev.start + minDuration)) : 0;
      const newStart = Math.min(group.start, Math.max(group.start - need, allowedStart));
      group.start = newStart;
      if (prev && prev.end > newStart) prev.end = newStart;
    }
  }

  const round = (x: number) => Math.round(x * 1000) / 1000;
  return groups.map((group) => ({
    start: round(group.start),
    end: round(group.end),
    text: w
      .slice(group.first, group.last + 1)
      .map((word) => word.text)
      .join(joiner)
      .trim(),
  }));
}
