import { ChevronLeft, ChevronRight, Megaphone, Plus, SearchX } from "lucide-react";
import type { Metadata } from "next";
import { type AnnouncementCardContext, AnnouncementCard } from "@/components/announcements/announcement-card";
import { FocusHere, TidyAddress } from "@/components/announcements/focus-here";
import { FocusOnPageChange } from "@/components/announcements/page-focus";
import { MarkAnnouncementsSeen } from "@/components/announcements/seen";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { FilterChips } from "@/components/tasks/filter-chips";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  type AnnouncementAudienceFilter,
  type AnnouncementFilters,
  announcementAnchor,
  announcementCountText,
  announcementsHref,
  parseAnnouncementFilters,
} from "@/lib/announcements";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { announcementsForYou, getAnnouncement, listAnnouncements } from "@/server/queries/announcements";

export const metadata: Metadata = { title: "Announcements" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** An announcement id from the URL, or undefined. */
function idParam(v: string | string[] | undefined): string | undefined {
  const s = first(v);
  return s && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : undefined;
}

/** Request time, read outside of render so relative labels line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

/**
 * The announcement to open the list at: after posting or saving (with what to say about it, on the announcement
 * itself), or `?focus=` (from Today, or leaving its edit page) without a message.
 */
function highlightFor(sp: Record<string, string | string[] | undefined>): { id: string; message: string | null } | null {
  const posted = idParam(sp.posted);
  if (posted) return { id: posted, message: "Posted. Everyone can read it now." };
  const saved = idParam(sp.saved);
  if (saved) return { id: saved, message: "Changes saved." };
  const unchanged = idParam(sp.unchanged);
  if (unchanged) return { id: unchanged, message: "Nothing changed, so there was nothing to save." };
  const focus = idParam(sp.focus);
  if (focus) return { id: focus, message: null };
  return null;
}

const FILTER_LABELS: Record<AnnouncementAudienceFilter, string> = {
  you: "For you",
  team: "Whole team",
  SOFTWARE: SUBTEAM_LABELS.SOFTWARE,
  BUILD: SUBTEAM_LABELS.BUILD,
  BUSINESS: SUBTEAM_LABELS.BUSINESS,
};

/** The count line (focused after Newer / Older). */
const COUNT_ID = "announcements-count";

function filteredEmptyText(filter: AnnouncementAudienceFilter): string {
  if (filter === "you") return "Nothing for you yet. Announcements for the whole team or your subteam show up here.";
  if (filter === "team") return "No announcements for the whole team yet.";
  return `No announcements just for ${SUBTEAM_LABELS[filter]} yet.`;
}

/** News from leaders, the captain, mentors, and teachers. Everyone reads all of it; "For you" narrows it down. */
export default async function AnnouncementsPage({ searchParams }: PageProps<"/announcements">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const parsed = parseAnnouncementFilters((key) => first(sp[key]));
  // For the captain, mentors, teachers, and owners everything is "for you": that chip would only repeat All.
  const everythingForYou = announcementsForYou(actor).all;
  const filters: AnnouncementFilters = parsed.for === "you" && everythingForYou ? { ...parsed, for: undefined } : parsed;
  const highlight = highlightFor(sp);
  const removed = first(sp.removed) === "1";
  const now = requestTime();
  const timeZone = env.teamTimezone;

  const list = await listAnnouncements(actor, { for: filters.for, page: filters.page, focusId: highlight?.id });
  if (!list) return null; // requireActiveUser already sent anyone else away
  const shown: AnnouncementFilters = { ...filters, page: list.page };
  const canPost = list.audiences.length > 0;
  const highlightShown = !!highlight && list.items.some((a) => a.id === highlight.id);
  // The saved announcement isn't on this page (e.g. a filtered link): say it above the list — only if it exists, so
  // an old or made-up link doesn't claim a save that didn't happen.
  const offPageMessage =
    highlight?.message && !highlightShown && (await getAnnouncement(actor, highlight.id)) ? highlight.message : null;

  // Once it's shown, the address keeps only which one to open at: a reload doesn't repeat "Posted.", and the #hash
  // is gone (see TidyAddress). When it isn't on the page, only the #hash goes.
  const tidyHref = highlightShown && highlight ? announcementsHref(filters, { focus: highlight.id }) : undefined;

  const ctx: AnnouncementCardContext = {
    now,
    timeZone,
    back: announcementsHref(shown).split("?")[1] ?? "",
    highlight: highlightShown ? highlight : null,
  };

  // Post for the subteam being looked at, when that's one the person can post for.
  const postFor = filters.for && filters.for !== "you" && filters.for !== "team" && list.audiences.includes(filters.for) ? filters.for : null;
  const postButton = (
    <ButtonLink href={postFor ? `/announcements/new?for=${postFor}` : "/announcements/new"}>
      <Plus className="size-4" aria-hidden />
      Post an announcement
    </ButtonLink>
  );

  const chips = [
    { href: announcementsHref({}), label: "All", active: !filters.for },
    ...((everythingForYou ? ["team", ...SUBTEAMS] : ["you", "team", ...SUBTEAMS]) as AnnouncementAudienceFilter[]).map((f) => ({
      href: announcementsHref({ for: f }),
      label: FILTER_LABELS[f],
      active: filters.for === f,
    })),
  ];

  return (
    <>
      <PageHeader
        title="Announcements"
        description="News from leaders, the captain, mentors, and teachers. Pinned ones first, then the newest."
        actions={canPost ? postButton : undefined}
      />
      {/* Everything posted up to now counts as seen once this is on screen (the "New" markers stay for this visit). */}
      <MarkAnnouncementsSeen upTo={now.toISOString()} />

      <div className="max-w-3xl space-y-4">
        {removed && <FocusAlert tone="success">Announcement removed.</FocusAlert>}
        {offPageMessage && <FocusAlert tone="success">{offPageMessage}</FocusAlert>}
        {highlightShown && highlight && <FocusHere targetId={announcementAnchor(highlight.id)} />}
        {highlight && <TidyAddress href={tidyHref} />}

        {list.anyAtAll && (
          <div className="space-y-2">
            <FilterChips label="Filter announcements" chips={chips} />
            {/* Says the filter (on a phone the picked chip can be scrolled out of sight) and the page. After Newer /
                Older, focus comes here. */}
            <p
              id={COUNT_ID}
              tabIndex={-1}
              className="rounded text-sm text-ink-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              aria-live="polite"
            >
              {announcementCountText(list.total, filters.for)}
              {list.pageCount > 1 && ` · page ${list.page} of ${list.pageCount}`}
            </p>
            <FocusOnPageChange page={list.page} targetId={COUNT_ID} />
          </div>
        )}

        {!list.anyAtAll ? (
          <Card>
            <EmptyState
              icon={Megaphone}
              title="No announcements yet"
              description="When a leader, the captain, a mentor, or a teacher posts news for the team, it shows up here."
              action={canPost ? postButton : undefined}
            />
          </Card>
        ) : list.items.length === 0 ? (
          <Card>
            <EmptyState
              icon={SearchX}
              title="Nothing here"
              description={filters.for ? filteredEmptyText(filters.for) : "No announcements on this page."}
              action={
                <ButtonLink href={announcementsHref({})} variant="secondary">
                  Show all announcements
                </ButtonLink>
              }
            />
          </Card>
        ) : (
          <>
            <div className="space-y-3">
              {list.items.map((item) => (
                <AnnouncementCard key={item.id} item={item} ctx={ctx} />
              ))}
            </div>
            {list.pageCount > 1 && (
              // The label stays in the middle whichever buttons there are.
              <nav aria-label="Pages" className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 pt-1">
                <div className="justify-self-start">
                  {list.page > 1 && (
                    <ButtonLink href={announcementsHref({ ...filters, page: list.page - 1 })} variant="secondary">
                      <ChevronLeft className="size-4" aria-hidden />
                      Newer
                    </ButtonLink>
                  )}
                </div>
                <span className="text-sm text-ink-500">
                  Page {list.page} of {list.pageCount}
                </span>
                <div className="justify-self-end">
                  {list.page < list.pageCount && (
                    <ButtonLink href={announcementsHref({ ...filters, page: list.page + 1 })} variant="secondary">
                      Older
                      <ChevronRight className="size-4" aria-hidden />
                    </ButtonLink>
                  )}
                </div>
              </nav>
            )}
          </>
        )}
      </div>
    </>
  );
}
