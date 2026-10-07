// Meeting recaps store their transcript and key points as plain text, one line each. A line may start with the
// moment in the meeting it belongs to — "[12:30] We go with the 4-bar intake." — so pages can link it to the
// recording. These helpers write and read that format. Client-safe, no DOM.

/** A transcript line or key point: when in the meeting (ms from the start, paused time left out) and what. */
export type TimedLine = { atMs: number | null; text: string };

/** "0:05", "12:30", "1:02:03" (hours only from one hour on). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// "[m:ss]", "[mm:ss]" (minutes may run past 59 when typed by hand) or "[h:mm:ss]" at the start of a line.
const TIME_PREFIX = /^\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]\s*/;
// A list marker someone typed or pasted: "- ", "* ", "• ", "1. ", "1) ".
const BULLET = /^(?:[-*•]|\d{1,3}[.)])\s+/;

/** One line's text: no line breaks inside, single spaces. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Splits a leading time prefix off a line. Invalid times ("[1:75]") are left in the text. */
function splitTime(line: string): TimedLine {
  const m = TIME_PREFIX.exec(line);
  if (!m) return { atMs: null, text: line };
  const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
  let seconds: number;
  if (c === null) {
    if (b > 59) return { atMs: null, text: line };
    seconds = a * 60 + b;
  } else {
    if (b > 59 || c > 59) return { atMs: null, text: line };
    seconds = a * 3600 + b * 60 + c;
  }
  return { atMs: seconds * 1000, text: line.slice(m[0].length) };
}

/** Transcript segments (`s` = start in ms) → "[m:ss] text" lines. Empty segments are skipped. */
export function formatTranscript(segments: { s: number | null; text: string }[]): string {
  return formatKeyPoints(segments.map((seg) => ({ atMs: seg.s, text: seg.text })));
}

/** Key points → one "[m:ss] text" (or plain "text") line each. Empty points are skipped. */
export function formatKeyPoints(points: TimedLine[]): string {
  const lines: string[] = [];
  for (const p of points) {
    const text = oneLine(p.text);
    if (!text) continue;
    lines.push(p.atMs === null || !Number.isFinite(p.atMs) ? text : `[${formatClock(p.atMs)}] ${text}`);
  }
  return lines.join("\n");
}

/** Saved transcript text → its lines. A missing time prefix is fine (atMs null); empty lines are dropped. */
export function parseTranscriptLines(text: string): TimedLine[] {
  const out: TimedLine[] = [];
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = splitTime(raw.trim());
    const t = oneLine(line.text);
    if (t) out.push({ atMs: line.atMs, text: t });
  }
  return out;
}

/** Saved key points → their lines, like parseTranscriptLines but also without a typed list marker ("- ", "1. "). */
export function parseKeyPointLines(text: string): TimedLine[] {
  const out: TimedLine[] = [];
  for (const raw of text.split(/\r\n?|\n/)) {
    let line = raw.trim().replace(BULLET, "");
    const timed = splitTime(line);
    line = timed.atMs === null ? line : timed.text.replace(BULLET, "");
    const t = oneLine(line);
    if (t) out.push({ atMs: timed.atMs, text: t });
  }
  return out;
}
