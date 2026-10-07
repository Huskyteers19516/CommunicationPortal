// Text handling for Chrome's built-in summarizer (the browser side lives in
// src/components/meetings/recorder/engine/chrome-summarizer.ts). Client-safe, no DOM, unit-tested.

/**
 * Splits text into chunks of at most `size` characters at line breaks; a single line longer than that is cut at
 * the last space or punctuation in its final fifth (or hard, when there's none). Ported from VoiceCollector's
 * notes.js (its summarize.js version never split long lines and could emit an empty first chunk).
 */
export function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.replace(/\n$/, ""));
    cur = "";
  };
  for (const line of String(text || "").split("\n")) {
    for (const piece of hardSplit(line, size)) {
      if (cur.length + piece.length > size && cur) push();
      cur += `${piece}\n`;
    }
  }
  push();
  return out;
}

function hardSplit(line: string, size: number): string[] {
  if (line.length <= size) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > size) {
    let cut = size;
    const from = Math.floor(size * 0.8);
    const m = rest.slice(from, size).match(/[\s,.;!?][^\s,.;!?]*$/);
    if (m && m.index !== undefined) cut = from + m.index + 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** The bullets of a markdown key-point list ("- …", "* …", "• …", "1. …"), without bold markers. */
export function parseSummaryBullets(markdown: string): string[] {
  const out: string[] = [];
  for (const line of String(markdown || "").split(/\r\n?|\n/)) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Whether a summary is unusable: empty, a "model not available" stub (an Electron/Chromium build answers that way
 * while still "succeeding"), or the input echoed back.
 */
export function isUnusableSummary(summary: string, input: string): boolean {
  if (!summary.trim()) return true;
  if (/model not available/i.test(summary)) return true;
  const strip = (x: string) => x.replace(/\s+/g, "");
  const head = strip(input).slice(0, 80);
  return head.length >= 40 && strip(summary).includes(head);
}
