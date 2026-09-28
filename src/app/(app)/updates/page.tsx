import { ChevronLeft, ChevronRight, PenLine, ScrollText, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { FocusHere } from "@/components/updates/focus-here";
import { type FeedContext, MeetingDaySection } from "@/components/updates/meeting-feed";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { formatDateOnly, isDateOnly, todayInTimezone } from "@/lib/dates";
import { type MeetingFeedFilters, meetingFeedHref, meetingUpdateAnchor, parseMeetingFeedFilters } from "@/lib/meeting-updates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getMeetingUpdate, getMeetingUpdatesFeed } from "@/server/queries/meeting-updates";

export const metadata: Metadata = { title: "Meeting updates" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** An update id from the URL (after saving), or undefined. */
function idParam(v: string | string[] | undefined): string | undefined {
  const s = first(v);
  return s && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : undefined;
}

/** Request time, read outside of render so relative labels line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

const WRITE_LABEL = "Write an update";

/**
 * The update to open the feed at: after saving (with what to say about it, on the update itself), or
 * `?focus=` (from Today, or leaving its edit page) without a message.
 */
function highlightFor(sp: Record<string, string | string[] | undefined>): { id: string; message: string | null } | null {
  const added = idParam(sp.added);
  if (added) return { id: added, message: "Posted. Thanks for writing it up!" };
  const saved = idParam(sp.saved);
  if (saved) return { id: saved, message: "Changes saved." };
  const unchanged = idParam(sp.unchanged);
  if (unchanged) return { id: unchanged, message: "Nothing changed, so there was nothing to save." };
  const focus = idParam(sp.focus);
  if (focus) return { id: focus, message: null };
  return null;
}

function FilteredEmpty({ filters }: { filters: MeetingFeedFilters }) {
  const label = filters.subteam ? SUBTEAM_LABELS[filters.subteam] : null;
  const title = filters.mine
    ? label
      ? `You haven't written any ${label} updates`
      : "You haven't written any updates yet"
    : `No ${label} updates yet`;
  return (
    <EmptyState
      icon={SearchX}
      title={title}
      description={filters.mine ? "Updates you write show up here." : "When someone writes one, it shows up here."}
      action={
        <ButtonLink href={meetingFeedHref({ mine: false })} variant="secondary">
          Show all updates
        </ButtonLink>
      }
    />
  );
}

/** Every subteam's meeting updates, newest meeting first. Everyone reads them; members write their subteam's. */
export default async function MeetingUpdatesPage({ searchParams }: PageProps<"/updates">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const filters = parseMeetingFeedFilters((key) => first(sp[key]));
  const highlight = highlightFor(sp);
  const removed = SUBTEAMS.find((s) => s === first(sp.removed));
  const removedDate = first(sp.date);
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone, now);

  const feed = await getMeetingUpdatesFeed(actor, { ...filters, focusId: highlight?.id });
  if (!feed) return null; // requireActiveUser already sent anyone else away
  const shown: MeetingFeedFilters = { ...filters, page: feed.page };
  const filtered = !!filters.subteam || filters.mine;
  const canWrite = feed.writable.length > 0;
  const highlightShown =
    !!highlight && feed.days.some((d) => SUBTEAMS.some((s) => d.bySubteam[s].some((u) => u.id === highlight.id)));
  // The saved update isn't on this page (e.g. a filtered link): say it above the feed — only if it exists, so an
  // old or made-up link doesn't claim a save that didn't happen.
  const offPageMessage =
    highlight?.message && !highlightShown && (await getMeetingUpdate(actor, highlight.id)) ? highlight.message : null;

  const ctx: FeedContext = {
    today,
    now,
    timeZone,
    writable: feed.writable,
    back: meetingFeedHref(shown).split("?")[1] ?? "",
    highlight: highlightShown ? highlight : null,
  };

  const writeButton = (
    <ButtonLink href="/updates/new">
      <PenLine className="size-4" aria-hidden />
      {WRITE_LABEL}
    </ButtonLink>
  );

  const subteamChips = [
    { href: meetingFeedHref({ ...filters, subteam: undefined, page: undefined }), label: "All", active: !filters.subteam },
    ...SUBTEAMS.map((s) => ({
      href: meetingFeedHref({ ...filters, subteam: s, page: undefined }),
      label: SUBTEAM_LABELS[s],
      active: filters.subteam === s,
    })),
  ];

  return (
    <>
      <PageHeader
        title="Meeting updates"
        description="What each subteam did at every meeting — written by the people who were there."
        actions={canWrite ? writeButton : undefined}
      />

      <div className="space-y-6">
        {removed && (
          <FocusAlert tone="success">
            Removed the {SUBTEAM_LABELS[removed]} update
            {removedDate && isDateOnly(removedDate) ? ` from ${formatDateOnly(removedDate, today)}` : ""}.
          </FocusAlert>
        )}
        {offPageMessage && <FocusAlert tone="success">{offPageMessage}</FocusAlert>}
        {highlightShown && highlight && <FocusHere targetId={meetingUpdateAnchor(highlight.id)} />}

        {feed.anyAtAll && (
          // items-start: the chips' scroller has room for focus rings above and below (see FilterChips).
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
            <FilterChips label="Filter by subteam" chips={subteamChips} />
            <div className="flex flex-wrap gap-2">
              <ToggleChip
                href={meetingFeedHref({ ...filters, mine: !filters.mine, page: undefined })}
                label="Mine"
                active={filters.mine}
              />
            </div>
          </div>
        )}

        {!feed.anyAtAll ? (
          <Card>
            <EmptyState
              icon={ScrollText}
              title="No meeting updates yet"
              description="After each meeting, someone from each subteam writes what they did, what's next, and anything they need help with."
              action={canWrite ? writeButton : undefined}
            />
          </Card>
        ) : feed.days.length === 0 ? (
          <Card>
            <FilteredEmpty filters={filters} />
          </Card>
        ) : (
          <>
            <div className="space-y-8">
              {feed.days.map((day) => (
                <MeetingDaySection key={day.date} day={day} ctx={ctx} filtered={filtered} />
              ))}
            </div>

            {feed.pageCount > 1 && (
              <nav aria-label="Pages" className="flex items-center justify-between gap-3">
                {feed.page > 1 ? (
                  <Link href={meetingFeedHref({ ...filters, page: feed.page - 1 })} className={buttonClasses("secondary")}>
                    <ChevronLeft className="size-4" aria-hidden />
                    Newer
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-sm text-ink-500">
                  Page {feed.page} of {feed.pageCount}
                </span>
                {feed.page < feed.pageCount ? (
                  <Link href={meetingFeedHref({ ...filters, page: feed.page + 1 })} className={buttonClasses("secondary")}>
                    Older
                    <ChevronRight className="size-4" aria-hidden />
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            )}
          </>
        )}
      </div>
    </>
  );
}
