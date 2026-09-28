// Discussion (/discussion), client-safe: the list's filters from the URL, links, labels, and the "New" divider rule.
import type { DiscussionCategory } from "@/generated/prisma/enums";
import { DISCUSSION_CATEGORIES } from "./constants";
import { cleanSearchText } from "./search";

/** Discussions per page on the list. */
export const DISCUSSION_PAGE_SIZE = 30;
/** Longest title search (`?q=`). */
export const DISCUSSION_SEARCH_MAX = 100;
/** Replies shown on a discussion's page (the newest ones; older ones get a note). */
export const DISCUSSION_REPLIES_SHOWN_MAX = 500;

export interface DiscussionFilters {
  category?: DiscussionCategory;
  /** Only discussions with something new for me (`?unread=1`). */
  unread: boolean;
  /** Only discussions I started (`?mine=1`). */
  mine: boolean;
  /** Part of the title (`?q=`). */
  q?: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The list's filters from the URL (`?category=&unread=1&mine=1&q=`); anything unexpected is ignored. */
export function parseDiscussionFilters(sp: SearchParams): DiscussionFilters {
  const category = first(sp.category);
  return {
    category: DISCUSSION_CATEGORIES.find((c) => c === category),
    unread: first(sp.unread) === "1",
    mine: first(sp.mine) === "1",
    q: cleanSearchText(first(sp.q), DISCUSSION_SEARCH_MAX),
  };
}

export function hasDiscussionFilters(f: DiscussionFilters): boolean {
  return !!(f.category || f.unread || f.mine || f.q);
}

/** The list with these filters (and page). */
export function discussionListHref(f: DiscussionFilters, page = 1): string {
  const sp = new URLSearchParams();
  if (f.category) sp.set("category", f.category);
  if (f.unread) sp.set("unread", "1");
  if (f.mine) sp.set("mine", "1");
  if (f.q) sp.set("q", f.q);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/discussion?${qs}` : "/discussion";
}

/** "Start a discussion", starting on the category being looked at. */
export function newDiscussionHref(category?: DiscussionCategory): string {
  return category ? `/discussion/new?category=${category}` : "/discussion/new";
}

export function discussionHref(threadId: string): string {
  return `/discussion/${encodeURIComponent(threadId)}`;
}

/** "No replies yet" / "1 reply" / "12 replies". */
export function repliesLabel(n: number): string {
  if (n === 0) return "No replies yet";
  return n === 1 ? "1 reply" : `${n.toLocaleString("en-US")} replies`;
}

/**
 * Where the "New" divider goes on a discussion's page: before the first reply (oldest first) written after `since`
 * by someone else. `since` = when I last opened it; null = nothing to mark (e.g. the whole discussion is new to me).
 */
export function firstNewReplyId(
  replies: { id: string; createdAt: Date; mine: boolean }[],
  since: Date | null,
): string | null {
  if (!since) return null;
  return replies.find((r) => !r.mine && r.createdAt.getTime() > since.getTime())?.id ?? null;
}
