// Exports of a meeting recap for everyone who can read it: "Copy key points", "Download .md" and "Download
// transcript .txt". Built in the browser from what the page already shows. Client-safe, no DOM.

import type { DateOnly } from "../dates";
import { formatMeetingDuration } from "../meeting-recaps";
import { formatClock, parseKeyPointLines, parseTranscriptLines, type TimedLine } from "./transcript-format";

export type RecapExport = {
  title: string;
  meetingDate: DateOnly;
  /** Category names, in the order shown. */
  categories: string[];
  durationSec: number | null;
  /** Saved key points text (one per line, optional "[m:ss] " prefix). */
  keyPoints: string;
  /** Saved transcript text (one line per segment, optional "[m:ss] " prefix). */
  transcript: string;
  /** Who recorded or wrote it up. */
  recordedBy?: string | null;
};

/** "Tue, Oct 7, 2026". */
function longDate(day: DateOnly): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
}

function timed(line: TimedLine, bold: boolean): string {
  if (line.atMs === null) return line.text;
  const clock = `[${formatClock(line.atMs)}]`;
  return `${bold ? `**${clock}**` : clock} ${line.text}`;
}

function details(recap: RecapExport): string[] {
  const out = [`Date: ${longDate(recap.meetingDate)}`];
  if (recap.durationSec !== null && recap.durationSec > 0) out.push(`Duration: ${formatMeetingDuration(recap.durationSec)}`);
  if (recap.categories.length) out.push(`Categories: ${recap.categories.join(", ")}`);
  if (recap.recordedBy) out.push(`Recorded by: ${recap.recordedBy}`);
  return out;
}

/** The key points as plain text for the clipboard: "- [12:30] Decision: …" per line ("" when there are none). */
export function keyPointsToClipboardText(keyPoints: string): string {
  return parseKeyPointLines(keyPoints)
    .map((p) => `- ${timed(p, false)}`)
    .join("\n");
}

/** The whole recap as Markdown: title, details, key points, transcript. */
export function recapToMarkdown(recap: RecapExport): string {
  const points = parseKeyPointLines(recap.keyPoints);
  const lines = parseTranscriptLines(recap.transcript);
  const out = [`# ${recap.title.replace(/\s+/g, " ").trim() || "Meeting recap"}`, "", ...details(recap).map((d) => `- ${d}`), ""];
  out.push("## Key points", "");
  if (points.length) out.push(...points.map((p) => `- ${timed(p, true)}`));
  else out.push("_No key points._");
  out.push("", "## Transcript", "");
  if (lines.length) for (const l of lines) out.push(timed(l, true), "");
  else out.push("_No transcript._", "");
  return `${out.join("\n").trimEnd()}\n`;
}

/** The transcript as plain text: a header (title, details), then one "[m:ss] text" line per segment. */
export function recapToPlainText(recap: RecapExport): string {
  const title = recap.title.replace(/\s+/g, " ").trim() || "Meeting recap";
  const lines = parseTranscriptLines(recap.transcript);
  const out = [title, details(recap).join(" · "), "-".repeat(Math.min(60, Math.max(20, title.length))), ""];
  if (lines.length) out.push(...lines.map((l) => timed(l, false)));
  else out.push("(No transcript.)");
  return `${out.join("\n")}\n`;
}

/**
 * A safe file name (without extension) for a recap's downloads: "<title> <date>", e.g. "Build meeting 2026-10-07".
 * No path or control characters, no characters Windows refuses, at most 100 characters of title.
 */
export function recapFileBase(title: string, date: DateOnly): string {
  const clean = Array.from(String(title || ""))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      // lone surrogates, bidi overrides and BOM can disguise or break a file name
      return !(code >= 0xd800 && code <= 0xdfff) && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069) && code !== 0xfeff;
    })
    .join("")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const base = Array.from(clean).slice(0, 100).join("").trim().replace(/[. ]+$/, "");
  return `${base || "Meeting recap"} ${date}`;
}
