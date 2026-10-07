// Meeting recaps' pages, client-safe: the labels the list, a recap's page, Today, and the recorder's review step share,
// which transcript line goes with a moment of the recording, and how the category picker catches up with the team's
// list. Data: src/server/queries/meeting-recaps.ts; the text format: src/lib/meeting-recorder/transcript-format.ts.
import type { MeetingAudioState, MeetingCategoryOption } from "./meeting-recaps";
import type { TimedLine } from "./meeting-recorder/transcript-format";

/** A line being played stays highlighted this long past its end (VoiceCollector's player), so short gaps don't flicker. */
const PLAYING_TOLERANCE_MS = 1500;
/** The last line's length when nothing says where it ends. */
const LAST_LINE_MS = 8000;

/**
 * Until when a recording is kept, in the team's timezone: "Fri 3:40 PM" (the list, Today) or "Fri, Oct 10, 3:40 PM"
 * (a recap's page, the recorder).
 */
export function meetingAudioUntilLabel(iso: string, timeZone: string, style: "short" | "long" = "short"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    ...(style === "long" ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/**
 * How a recap came to be, for "… by Jordan Lee": "Recorded" when it came from a recording (the recorder saves the
 * meeting's length, and maybe the recording), else "Written up" (/meetings/new has neither).
 */
export function meetingRecapOrigin(recap: { durationSec: number | null; audio: MeetingAudioState }): "Recorded" | "Written up" {
  return recap.durationSec !== null || recap.audio.state !== "none" ? "Recorded" : "Written up";
}

const KEY_POINT_LABEL = /^((?:Decision|To do)(?: \([^()]{1,80}\))?):\s+(\S.*)$/;

/**
 * The label the recorder's key points start with ("Decision: …", "To do (Alice, by Friday): …"), split off so pages can
 * show it in bold. `label` is null for any other point.
 */
export function splitKeyPointLabel(text: string): { label: string | null; text: string } {
  const m = KEY_POINT_LABEL.exec(text);
  return m ? { label: m[1], text: m[2] } : { label: null, text };
}

/**
 * The transcript line that goes with a moment (ms into the recording): the one with the latest time at or before it
 * (the first of equal ones), or the earliest one when the moment comes before them all. -1 when no line has a time.
 * Times typed by hand may be out of order, so every line is looked at.
 */
export function transcriptLineAt(lines: TimedLine[], ms: number): number {
  let best = -1;
  let earliest = -1;
  lines.forEach((line, i) => {
    if (line.atMs === null) return;
    if (earliest === -1 || line.atMs < lines[earliest].atMs!) earliest = i;
    if (line.atMs <= ms && (best === -1 || line.atMs > lines[best].atMs!)) best = i;
  });
  return best === -1 ? earliest : best;
}

/**
 * The line being played at `ms`, or -1: none before the first timed line, and none once playback is past the line's
 * end (the next line's start; for the last one the recording's end, or 8 s) by more than 1.5 s — a long silence
 * doesn't keep the line before it highlighted.
 */
export function playingTranscriptLine(lines: TimedLine[], ms: number, durationMs: number | null): number {
  let best = -1;
  lines.forEach((line, i) => {
    if (line.atMs !== null && line.atMs <= ms && (best === -1 || line.atMs > lines[best].atMs!)) best = i;
  });
  if (best === -1) return -1;
  const start = lines[best].atMs!;
  let end: number | null = null;
  for (const line of lines) {
    if (line.atMs !== null && line.atMs > start && (end === null || line.atMs < end)) end = line.atMs;
  }
  end ??= durationMs !== null && durationMs > start ? durationMs : start + LAST_LINE_MS;
  return ms <= end + PLAYING_TOLERANCE_MS ? best : -1;
}

/** A category name the way the server compares them (services' categoryNameKey): spaces tidied, case ignored. */
export function meetingCategoryKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The category called `name` on the list, ignoring case and extra spaces ("drive  team" finds “Drive team”). */
export function findMeetingCategory(list: readonly MeetingCategoryOption[], name: string): MeetingCategoryOption | undefined {
  const key = meetingCategoryKey(name);
  return key ? list.find((c) => meetingCategoryKey(c.name) === key) : undefined;
}

/**
 * The category picker catching up with a fresh copy of the team's list (`next`, after the page refreshed; `before`:
 * the copy it had). Categories added in the picker (`added`) that the list now has are left to the list, so a later
 * delete removes them too; the rest stay (the refresh that lists them may still be on its way). Picks on neither list
 * were deleted meanwhile: they're dropped from `selected`, and `removed` names the ones the picker knew.
 */
export function catchUpMeetingCategories(input: {
  before: readonly MeetingCategoryOption[];
  next: readonly MeetingCategoryOption[];
  added: readonly MeetingCategoryOption[];
  selected: readonly string[];
}): { added: MeetingCategoryOption[]; selected: string[]; removed: string[] } {
  const listed = new Set(input.next.map((c) => c.id));
  const added = input.added.filter((c) => !listed.has(c.id));
  const known = new Set([...listed, ...added.map((c) => c.id)]);
  const names = new Map([...input.before, ...input.added].map((c) => [c.id, c.name]));
  const removed: string[] = [];
  for (const id of input.selected) {
    const name = known.has(id) ? undefined : names.get(id);
    if (name !== undefined) removed.push(name);
  }
  return { added, selected: input.selected.filter((id) => known.has(id)), removed };
}

/** “Outreach” was deleted from the team's list, so it isn't picked anymore. (Empty for no names.) */
export function removedMeetingCategoriesText(names: readonly string[]): string {
  if (names.length === 0) return "";
  const quoted = names.map((n) => `“${n}”`);
  const list =
    quoted.length === 1 ? quoted[0] : quoted.length === 2 ? `${quoted[0]} and ${quoted[1]}` : `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
  return quoted.length === 1
    ? `${list} was deleted from the team's list, so it isn't picked anymore.`
    : `${list} were deleted from the team's list, so they aren't picked anymore.`;
}
