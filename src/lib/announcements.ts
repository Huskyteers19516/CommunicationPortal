// Announcements (/announcements): client-safe helpers shared by the pages, the Today card, and the services.
import type { Subteam } from "@/generated/prisma/enums";
import { SUBTEAM_LABELS, SUBTEAMS } from "./constants";

/**
 * The "For" filter chips: `you` = the whole team's plus your subteam's (all-scope staff: everything), `team` =
 * whole-team ones only, or one subteam's. No filter = all of them.
 */
export type AnnouncementAudienceFilter = "you" | "team" | Subteam;

export interface AnnouncementFilters {
  for?: AnnouncementAudienceFilter;
  page?: number;
}

/** The form's "For" choice: "team" = the whole team, else one subteam. */
export type AnnouncementAudienceValue = "team" | Subteam;

export function audienceValue(subteam: Subteam | null): AnnouncementAudienceValue {
  return subteam ?? "team";
}

/** What the post / edit form shows (editing: also the id and the `version` — the updatedAt, ISO — it loaded). */
export interface AnnouncementFormValues {
  id?: string;
  version?: string;
  title: string;
  body: string;
  audience: AnnouncementAudienceValue;
  pinned: boolean;
}

/** A form's submitted fields (as the failed action echoes them back) as form values. */
export function submittedAnnouncementValues(values: Record<string, string>): Omit<AnnouncementFormValues, "id" | "version"> {
  return {
    title: values.title ?? "",
    body: values.body ?? "",
    audience: values.audience as AnnouncementAudienceValue,
    // An unticked checkbox isn't sent.
    pinned: values.pinned === "on",
  };
}

/**
 * After "someone else changed this announcement while you were editing": the newest values, except for the fields
 * this person changed from what their form had loaded — those stay theirs. So saving again only replaces what they
 * changed (an untouched "Pin to the top" box doesn't quietly unpin what someone pinned meanwhile).
 */
export function mergeAnnouncementEdits(
  loaded: AnnouncementFormValues,
  submitted: Omit<AnnouncementFormValues, "id" | "version">,
  latest: AnnouncementFormValues,
): AnnouncementFormValues {
  const pick = <K extends "title" | "body" | "audience" | "pinned">(key: K) =>
    submitted[key] !== loaded[key] ? submitted[key] : latest[key];
  return { ...latest, title: pick("title"), body: pick("body"), audience: pick("audience"), pinned: pick("pinned") };
}

/** "the whole team" / "Build". */
export function audienceLabel(subteam: Subteam | null): string {
  return subteam ? SUBTEAM_LABELS[subteam] : "the whole team";
}

const FOR_VALUES: readonly AnnouncementAudienceFilter[] = ["you", "team", ...SUBTEAMS];

/** Filters from the URL; anything else (a made-up `for`, a bad page) is dropped. */
export function parseAnnouncementFilters(get: (key: string) => string | undefined): AnnouncementFilters {
  const forValue = FOR_VALUES.find((v) => v === get("for"));
  const n = Number(get("page"));
  const page = Number.isInteger(n) && n > 1 ? Math.min(n, 10_000) : undefined;
  return { ...(forValue ? { for: forValue } : {}), ...(page ? { page } : {}) };
}

/** The list with these filters (and any `extra` params, e.g. `removed=1`). Page 1 and "All" stay out of the URL. */
export function announcementsHref(filters: AnnouncementFilters, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams();
  if (filters.for) sp.set("for", filters.for);
  if (filters.page && filters.page > 1) sp.set("page", String(filters.page));
  for (const [key, value] of Object.entries(extra)) sp.set(key, value);
  const qs = sp.toString();
  return qs ? `/announcements?${qs}` : "/announcements";
}

/** The element id of an announcement on the list. */
export function announcementAnchor(id: string): string {
  return `announcement-${id}`;
}

/** Opens the list on the page that has this announcement, scrolled to it (and focused). */
export function announcementFocusHref(id: string): string {
  return `${announcementsHref({}, { focus: id })}#${announcementAnchor(id)}`;
}

/**
 * Whether an announcement is "New" for the viewer: for them (the whole team's, their subteam's; all-scope staff:
 * everything), not theirs, and posted after `since` (when they last opened Announcements, or when they joined) —
 * the same ones the menu badge and Today count.
 */
export function isNewAnnouncement(
  a: { createdAt: Date | string; mine: boolean; forYou: boolean },
  since: Date | string | null,
): boolean {
  if (a.mine || !a.forYou || since === null) return false;
  return new Date(a.createdAt).getTime() > new Date(since).getTime();
}

/** "17 announcements for Build", "3 announcements for you", "1 announcement" (no filter). */
export function announcementCountText(total: number, filter?: AnnouncementAudienceFilter): string {
  const count = total === 1 ? "1 announcement" : `${total} announcements`;
  if (!filter) return count;
  if (filter === "you") return `${count} for you`;
  return `${count} for ${audienceLabel(filter === "team" ? null : filter)}`;
}
