// Meeting updates: client-safe helpers shared by the service, the pages, and the form.
import type { Subteam } from "@/generated/prisma/enums";
import { SUBTEAM_LABELS, SUBTEAMS } from "./constants";
import { addDays, type DateOnly, isDateOnly } from "./dates";

/** How far back a new update's meeting date may go (an edit may keep a date it already has). */
export const MEETING_UPDATE_MAX_PAST_DAYS = 365;

export const MEETING_DATE_IN_FUTURE = "The meeting date can't be in the future.";
export const MEETING_DATE_TOO_OLD = "That's more than a year ago. Check the date.";

/** The earliest and latest meeting date a new update accepts (the date field's min/max). */
export function meetingDateBounds(today: DateOnly): { min: DateOnly; max: DateOnly } {
  return { min: addDays(today, -MEETING_UPDATE_MAX_PAST_DAYS), max: today };
}

/** Null when a new update may use `date`, else what to fix. */
export function meetingDateProblem(date: DateOnly, today: DateOnly): string | null {
  const { min, max } = meetingDateBounds(today);
  if (date > max) return MEETING_DATE_IN_FUTURE;
  if (date < min) return MEETING_DATE_TOO_OLD;
  return null;
}

/** `?date=` prefill: a real date a new update may use, else undefined. */
export function prefillMeetingDate(value: string | undefined, today: DateOnly): DateOnly | undefined {
  if (!value || !isDateOnly(value)) return undefined;
  return meetingDateProblem(value, today) ? undefined : value;
}

/** Filters on the /updates feed (all from the URL). */
export interface MeetingFeedFilters {
  subteam?: Subteam;
  mine: boolean;
  page?: number;
}

/** Validated feed filters from `?subteam=`, `?who=mine`, and `?page=` (anything else is ignored). */
export function parseMeetingFeedFilters(get: (key: string) => string | undefined): MeetingFeedFilters {
  const subteam = SUBTEAMS.find((s) => s === get("subteam"));
  const rawPage = get("page");
  const n = rawPage && /^\d{1,5}$/.test(rawPage) ? Number(rawPage) : NaN;
  return { subteam, mine: get("who") === "mine", page: Number.isInteger(n) && n > 1 ? n : undefined };
}

/** The feed's URL for these filters (page 1 is left out). `extra` adds e.g. `removed=BUILD`. */
export function meetingFeedHref(f: MeetingFeedFilters, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams();
  if (f.subteam) sp.set("subteam", f.subteam);
  if (f.mine) sp.set("who", "mine");
  if (f.page && f.page > 1) sp.set("page", String(f.page));
  for (const [key, value] of Object.entries(extra)) sp.set(key, value);
  const qs = sp.toString();
  return qs ? `/updates?${qs}` : "/updates";
}

/** The "Write one" link for a subteam and day. */
export function newMeetingUpdateHref(date: DateOnly, subteam: Subteam): string {
  return `/updates/new?${new URLSearchParams({ date, subteam }).toString()}`;
}

/** The element id of an update on the feed (the redirect after saving scrolls to it). */
export function meetingUpdateAnchor(id: string): string {
  return `update-${id}`;
}

/** The feed, opened at one update (its page, scrolled to it and focused), e.g. from Today or "Cancel" on its edit page. */
export function meetingUpdateFocusHref(id: string): string {
  return `/updates?${new URLSearchParams({ focus: id }).toString()}#${meetingUpdateAnchor(id)}`;
}

/** "Build", "Build and Business" (or "Build or Business"), "all three subteams" — in Software, Build, Business order. */
export function subteamList(subteams: Subteam[], joiner: "and" | "or" = "and"): string {
  const labels = SUBTEAMS.filter((s) => subteams.includes(s)).map((s) => SUBTEAM_LABELS[s]);
  if (labels.length === SUBTEAMS.length) return "all three subteams";
  return labels.join(` ${joiner} `);
}

/**
 * Meeting days that are missing a subteam's update: for each of `days` (e.g. the days attendance was taken),
 * the subteams nobody wrote one for, oldest day first. Days with all three are left out.
 */
export function missingMeetingUpdates(
  days: DateOnly[],
  updates: { meetingDate: DateOnly; subteam: Subteam }[],
): { date: DateOnly; subteams: Subteam[] }[] {
  const written = new Set(updates.map((u) => `${u.meetingDate} ${u.subteam}`));
  return [...new Set(days)]
    .sort()
    .map((date) => ({ date, subteams: SUBTEAMS.filter((s) => !written.has(`${date} ${s}`)) }))
    .filter((d) => d.subteams.length > 0);
}
