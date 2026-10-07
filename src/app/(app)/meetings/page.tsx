import { AudioLines, Mic, PenLine, Search, SearchX, Tags } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { KeepChipInView } from "@/components/discussion/keep-chip-in-view";
import { MeetingRecapCard } from "@/components/meetings/meeting-recap-card";
import { RecorderLink } from "@/components/meetings/recorder-link";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { FilterChips } from "@/components/tasks/filter-chips";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { todayInTimezone } from "@/lib/dates";
import {
  MEETING_SEARCH_MAX,
  type MeetingRecapFilters,
  meetingRecapCountText,
  meetingRecapsHref,
  parseMeetingRecapFilters,
} from "@/lib/meeting-recaps";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { scheduleMeetingAudioPurge } from "@/server/meetings/purge";
import { listMeetingRecaps } from "@/server/queries/meeting-recaps";

export const metadata: Metadata = { title: "Meeting recaps" };

/** Request time, read outside of render so "Recording until …" lines up with the data. */
function requestTime(): Date {
  return new Date();
}

/** A plain GET form, so the search lives in the URL (the category chip's filter rides along). */
function SearchForm({ filters }: { filters: MeetingRecapFilters }) {
  return (
    <form method="get" action="/meetings" role="search" className="flex min-w-0 gap-2">
      {filters.category && <input type="hidden" name="category" value={filters.category} />}
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
        <Input
          type="search"
          name="q"
          defaultValue={filters.q ?? ""}
          placeholder="Search titles, key points, transcripts"
          aria-label="Search meeting recaps"
          maxLength={MEETING_SEARCH_MAX}
          autoComplete="off"
          enterKeyHint="search"
          className="pl-9"
        />
      </div>
      <Button type="submit" variant="secondary">
        Search
      </Button>
    </form>
  );
}

/**
 * Meeting recaps: the key points (and transcript) of the team's meetings, newest meeting first, for everyone. People
 * with admin access record (the recorder is its own page, entered with a full page load), write up, and keep the
 * categories. Recordings past their 3 days are deleted after the response.
 */
export default async function MeetingRecapsPage({ searchParams }: PageProps<"/meetings">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const filters = parseMeetingRecapFilters(sp);
  const removed = (Array.isArray(sp.removed) ? sp.removed[0] : sp.removed) === "1";
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone, now);
  scheduleMeetingAudioPurge();

  const list = await listMeetingRecaps(actor, filters, now);
  if (!list) return null; // requireActiveUser already sent anyone else away
  const filtered = !!(filters.category || filters.q);

  const recordLink = (
    <RecorderLink className={buttonClasses("primary")}>
      <Mic className="size-4" aria-hidden />
      Record a meeting
    </RecorderLink>
  );
  const writeLink = (
    <ButtonLink href="/meetings/new" variant="secondary">
      <PenLine className="size-4" aria-hidden />
      Write one up
    </ButtonLink>
  );
  const chips = [
    { href: meetingRecapsHref({ q: filters.q }), label: "All", active: !filters.category },
    ...list.categories.map((c) => ({
      href: meetingRecapsHref({ q: filters.q, category: c.id }),
      label: c.name,
      active: filters.category === c.id,
    })),
  ];

  return (
    <>
      <PageHeader
        title="Meeting recaps"
        description="Key points from team meetings. Recordings are kept for 3 days."
        actions={
          list.canManage ? (
            <>
              {recordLink}
              {writeLink}
              <ButtonLink href="/meetings/categories" variant="ghost">
                <Tags className="size-4" aria-hidden />
                Categories
              </ButtonLink>
            </>
          ) : undefined
        }
      />

      <div className="max-w-3xl space-y-4">
        {removed && <FocusAlert tone="success">Recap deleted.</FocusAlert>}

        {list.anyAtAll && (
          <div className="space-y-3">
            {/* Keyed by the filters, so a chip or "Clear filters" (client navigations) resets the box too. */}
            <SearchForm key={JSON.stringify(filters)} filters={filters} />
            {list.categories.length > 0 && (
              <KeepChipInView active={filters.category ?? "ALL"}>
                <FilterChips label="Filter by category" chips={chips} />
              </KeepChipInView>
            )}
            <div className="flex flex-wrap items-center justify-between gap-x-3">
              {/* Says the filter (on a phone the picked chip can be scrolled out of sight) and the page. */}
              <p className="text-sm text-ink-500 wrap-anywhere" aria-live="polite">
                {meetingRecapCountText(list.total, {
                  categoryName: list.category?.name,
                  q: filters.q,
                  page: list.page,
                  pageCount: list.pageCount,
                })}
              </p>
              {filtered && (
                <Link href="/meetings" className="inline-flex min-h-10 items-center text-sm font-medium text-brand-700 hover:underline">
                  Clear filters
                </Link>
              )}
            </div>
          </div>
        )}

        {!list.anyAtAll ? (
          <Card>
            <EmptyState
              icon={AudioLines}
              title="No meeting recaps yet"
              description={
                list.canManage
                  ? "Record the next team meeting, or write up one that already happened. Everyone on the team can read them."
                  : "When a leader, the captain, a mentor, or a teacher saves the key points of a meeting, they show up here."
              }
              action={
                list.canManage ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    {recordLink}
                    {writeLink}
                  </div>
                ) : undefined
              }
            />
          </Card>
        ) : list.items.length === 0 ? (
          <Card>
            <EmptyState
              icon={SearchX}
              title="No recaps match"
              description={filtered ? "Try another category or search, or clear the filters." : "No recaps on this page."}
              action={
                <ButtonLink href="/meetings" variant="secondary">
                  Show all recaps
                </ButtonLink>
              }
            />
          </Card>
        ) : (
          <>
            <ul className="space-y-3">
              {list.items.map((recap) => (
                <li key={recap.id} className="min-w-0">
                  <MeetingRecapCard recap={recap} today={today} timeZone={timeZone} />
                </li>
              ))}
            </ul>
            <Pagination page={list.page} pageCount={list.pageCount} hrefFor={(page) => meetingRecapsHref({ ...filters, page })} />
          </>
        )}
      </div>
    </>
  );
}
