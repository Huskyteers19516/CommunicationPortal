// Cleaning up what Whisper writes, ported from VoiceCollector's whisper.js / app.js (tested there on real
// classroom recordings, 2026-10-06). Client-safe, no DOM. Used by the live transcript (stream-windower.ts) and
// by whole-file transcription (transcribeBlob in the recorder engine).
//
// Two problems this solves:
//   1. Runaway loops. When Whisper can't hear well it repeats a phrase over and over — measured: small repeated
//      "I think it's like," 74 times, base repeated "like, I'm" 107 times and "Okay." 14 times.
//   2. Re-recognised text. Neighbouring windows share a few seconds of audio, so the end of one window comes back
//      at the start of the next, and the joins of long-file chunks occasionally say a sentence twice.
// Rule of thumb: delete as little as possible. A phrase said exactly twice stays ("No, no." is natural speech;
// "X. X, but Y." is someone restating and adding to a point).

/** A word: its comparison form (lower case, no edge punctuation) and where it starts in the original string. */
export type Token = { n: string; start: number };

/** What dropRepeats remembers between calls: the last words kept and the last 3 sentences (normalised). */
export type RepeatMemory = { words: string[]; sents: string[] };

/** One piece of Whisper output with timestamps (seconds; the last piece of a file may have no end). */
export type AsrChunk = { text: string; timestamp: [number, number | null] };

/** A transcript segment: start and end in ms from the start of the recording (paused time left out). */
export type TimedSegment = { s: number; e: number | null; text: string };

export function createRepeatMemory(): RepeatMemory {
  return { words: [], sents: [] };
}

// Latin words (with apostrophes and hyphens), single CJK characters, or any other non-space character.
const TOKEN_RE = /[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’-]*|[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]|[^\s]/g;

const NUMBER_WORDS: Record<string, string> = Object.fromEntries(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((w, i) => [w, String(i)])
    .concat("thirty forty fifty sixty seventy eighty ninety".split(" ").map((w, i) => [w, String((i + 3) * 10)])),
);

/** A word's comparison form: lower case, no edge punctuation, "four" → "4", "31st" → "31". */
function compareForm(word: string): string {
  const n = word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/^(\d+)(?:st|nd|rd|th)$/, "$1");
  return NUMBER_WORDS[n] ?? n;
}

/**
 * Words for comparing two recognitions of the same audio. Comparison ignores case and punctuation (both vary
 * between runs), spelled-out numbers and hyphens (one window hears "four-bar", the next "4 bar"), but every token
 * keeps its start index, so callers cut the ORIGINAL string and keep its punctuation and spacing. Pure punctuation
 * is dropped.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  if (!text) return out;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    let offset = 0;
    for (const part of m[0].split("-")) {
      const n = compareForm(part);
      if (n) out.push({ n, start: m.index + offset });
      offset += part.length + 1;
    }
  }
  return out;
}

/**
 * How many words at the end of `prev` are said again at the start of `cur` (the overlap of two windows), at most
 * `maxK` — limited so a sentence really said twice isn't deleted. Two passes, the longer result wins:
 *   1. exact: prev's last k words equal cur's first k, from k = maxK down;
 *   2. fuzzy (k ≥ 3): at least 70% of the positions equal ("fifty meters" / "50 meters" between runs).
 * Both always run: an exact match on a stray "the" (k = 1) would otherwise hide a much longer real overlap.
 * Words, not characters: characters would cut "the" / "there" in the middle.
 */
export function overlapJoinLength(prev: Token[], cur: Token[], maxK: number): number {
  const limit = Math.min(maxK, prev.length, cur.length);
  if (limit <= 0) return 0;

  let exactK = 0;
  for (let k = limit; k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i].n !== cur[i].n) {
        ok = false;
        break;
      }
    }
    if (ok) {
      exactK = k;
      break;
    }
  }

  let bestK = 0;
  let bestScore = 0;
  for (let k = limit; k >= 3; k--) {
    if (k <= exactK) break; // only shorter from here on
    let hit = 0;
    for (let i = 0; i < k; i++) if (prev[prev.length - k + i].n === cur[i].n) hit++;
    const score = hit / k;
    if (score >= 0.7 && score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  return Math.max(exactK, bestK);
}

function sameRun(t: Token[], a: number, b: number, n: number): boolean {
  for (let i = 0; i < n; i++) if (t[a + i].n !== t[b + i].n) return false;
  return true;
}

/**
 * Collapses runaway loops: any phrase of 1–12 words repeated 3 or more times in a row is kept once. Exactly two
 * copies stay. The shortest repeating unit is tried first — trying long units first left "I think it's like" ×74
 * as three copies (one 12-word block), which is still a loop.
 */
export function collapseLoops(text: string): string {
  if (!text) return text;
  const t = tokenize(text);
  if (t.length < 3) return text;
  const cut: [number, number][] = [];
  let i = 0;
  while (i < t.length) {
    let done = false;
    for (let n = 1; n <= Math.min(12, Math.floor((t.length - i) / 3)) && !done; n++) {
      let reps = 1;
      while (i + (reps + 1) * n <= t.length && sameRun(t, i, i + reps * n, n)) reps++;
      if (reps >= 3) {
        const keepEnd = i + n; // keep the first copy
        const dropEnd = i + reps * n; // drop the rest
        cut.push([t[keepEnd] ? t[keepEnd].start : text.length, t[dropEnd] ? t[dropEnd].start : text.length]);
        i = dropEnd;
        done = true;
      }
    }
    if (!done) i++;
  }
  if (!cut.length) return text;
  let out = "";
  let pos = 0;
  for (const [a, b] of cut) {
    out += text.slice(pos, a);
    pos = b;
  }
  out += text.slice(pos);
  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function trigrams(words: string[]): string[] {
  const g: string[] = [];
  for (let i = 0; i + 2 < words.length; i++) g.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return g;
}

/**
 * Drops sentences that repeat what was just said. `memory` (updated in place) carries the last 200 kept words
 * and the last 3 sentences across calls. A sentence is dropped when:
 *   - it is identical to one of the last 3 sentences (catches short loops spread over windows, like an
 *     alternating "This is our H.I.S." / "4.3.4." Whisper invents in a quiet room), or
 *   - it has 5+ words and at least 70% of its word triples appeared in the last 60 words (re-recognised text).
 */
export function dropRepeats(text: string, memory: RepeatMemory): string {
  if (!text) return text;
  const keep: string[] = [];
  for (const sent of text.split(/(?<=[.!?])\s+/)) {
    const toks = tokenize(sent).map((x) => x.n);
    const norm = toks.join(" ");
    if (norm && memory.sents.includes(norm)) continue;
    if (norm) {
      memory.sents.push(norm);
      if (memory.sents.length > 3) memory.sents.shift();
    }
    if (toks.length >= 5 && memory.words.length >= 3) {
      const seen = new Set(trigrams(memory.words.slice(-60)));
      const g = trigrams(toks);
      const hit = g.filter((x) => seen.has(x)).length;
      if (g.length && hit / g.length >= 0.7) continue;
    }
    keep.push(sent);
    for (const w of toks) memory.words.push(w);
    if (memory.words.length > 200) memory.words.splice(0, memory.words.length - 200);
  }
  return keep.join(" ").trim();
}

/**
 * Whole-file results: each chunk loses its loops, then re-recognised sentences are dropped across chunks; the
 * text is rebuilt from the cleaned chunks. Chunks left empty are removed.
 */
export function cleanTranscript(result: { text: string; chunks: AsrChunk[] }): { text: string; chunks: AsrChunk[] } {
  const memory = createRepeatMemory();
  if (result.chunks.length) {
    const chunks: AsrChunk[] = [];
    for (const c of result.chunks) {
      const x = dropRepeats(collapseLoops(String(c.text || "").trim()), memory);
      if (x) chunks.push({ ...c, text: ` ${x}` });
    }
    return { text: chunks.map((c) => c.text.trim()).join(" "), chunks };
  }
  return { text: dropRepeats(collapseLoops(String(result.text || "")), memory), chunks: [] };
}

/**
 * Whisper's timestamped chunks are half sentences. Joins them into sentences (ending at . ! ? or after more than
 * 40 words); each takes its first chunk's start and its last chunk's end (ms). `offsetMs` shifts every time (a
 * file transcribed in pieces).
 */
export function chunksToSegments(chunks: AsrChunk[], offsetMs = 0): TimedSegment[] {
  const segs: TimedSegment[] = [];
  let buf = "";
  let s: number | null = null;
  let e: number | null = null;
  const flush = () => {
    const text = buf.replace(/\s+/g, " ").trim();
    if (text) segs.push({ s: Math.round(offsetMs + (s ?? 0) * 1000), e: e === null ? null : Math.round(offsetMs + e * 1000), text });
    buf = "";
    s = null;
    e = null;
  };
  for (const c of chunks) {
    const [from, to] = c.timestamp ?? [null, null];
    if (s === null) s = typeof from === "number" ? from : 0;
    if (typeof to === "number") e = to;
    buf += ` ${String(c.text || "").trim()}`;
    const joined = buf.trim();
    if (/[.!?]["')\]]?$/.test(joined) || joined.split(/\s+/).length > 40) flush();
  }
  flush();
  return segs;
}

/**
 * Splits one timed piece of text (a live window's final text, ~22 s) into sentences, spreading the time span by
 * each sentence's share of the characters. Sentences under 4 words are joined to the next one. Without an end
 * time every sentence gets the start time.
 */
export function splitSegmentSentences(seg: TimedSegment): TimedSegment[] {
  const text = seg.text.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const parts: string[] = [];
  let carry = "";
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    const joined = carry ? `${carry} ${piece}` : piece;
    if (joined.split(" ").length < 4) {
      carry = joined;
      continue;
    }
    parts.push(joined);
    carry = "";
  }
  if (carry) {
    if (parts.length) parts[parts.length - 1] += ` ${carry}`;
    else parts.push(carry);
  }
  const span = seg.e !== null && seg.e > seg.s ? seg.e - seg.s : 0;
  const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
  const out: TimedSegment[] = [];
  let acc = 0;
  for (const p of parts) {
    const s = Math.round(seg.s + (span * acc) / totalChars);
    acc += p.length;
    out.push({ s, e: span ? Math.round(seg.s + (span * acc) / totalChars) : seg.e, text: p });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Silence hallucinations
// ---------------------------------------------------------------------------
//
// On near-silent audio Whisper writes things it saw at the end of countless subtitled videos: "Thank you.",
// "you", "Thanks for watching!", "[BLANK_AUDIO]", "(music)". Bracketed sound labels are never speech and are
// always removed; the stock phrases are only removed when the audio they came from was mostly silent (a real
// "Thank you." after a long pause in a meeting stays).

/** Below this share of speech (see vad.ts speechRatio) a window counts as near-silent. */
export const LOW_SPEECH_RATIO = 0.35;

// "[BLANK_AUDIO]", "(music)", "[soft music playing]", "*laughs*", "♪ ♪". Whisper only brackets sound labels.
const SOUND_LABEL =
  /[[(*♪]+\s*(?:[a-z]+\s+){0,2}(?:blank[_ ]audio|silence|music|applause|laughter|laughs|inaudible|noise|static|no audio|sound|beep|coughs?|clears throat|sighs?|typing)(?:\s+[a-z]+){0,2}\s*[\])*♪]+|♪+/gi;

const HALLUCINATIONS = new Set(
  [
    "you",
    "thank you",
    "thank you very much",
    "thank you so much",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "thanks for watching and see you next time",
    "please subscribe",
    "please like and subscribe",
    "subscribe to my channel",
    "see you next time",
    "see you in the next video",
    "i'll see you next time",
    "bye",
    "bye bye",
    "goodbye",
    "okay",
    "oh",
    "so",
    "the end",
    "subtitles by the amara.org community",
  ].map(hallucinationKey),
);

function hallucinationKey(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a sentence is one of Whisper's stock silence phrases ("Thank you.", "you", "Thanks for watching!"). */
export function isSilencePhrase(sentence: string): boolean {
  const key = hallucinationKey(sentence);
  return key ? HALLUCINATIONS.has(key) : false;
}

/**
 * Removes sound labels always, and stock silence phrases when `speechRatio` (share of the audio with speech in
 * it) is below LOW_SPEECH_RATIO. Returns the cleaned text ("" when nothing real is left).
 */
export function dropSilenceHallucinations(text: string, speechRatio: number): string {
  const unlabeled = text.replace(SOUND_LABEL, " ").replace(/\s+/g, " ").trim();
  if (!unlabeled || speechRatio >= LOW_SPEECH_RATIO) return unlabeled;
  return unlabeled
    .split(/(?<=[.!?])\s+/)
    .filter((sent) => hallucinationKey(sent) && !isSilencePhrase(sent))
    .join(" ")
    .trim();
}
