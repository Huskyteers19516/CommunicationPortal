import { MessagesSquare, Plus, Search, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { KeepChipInView } from "@/components/discussion/keep-chip-in-view";
import { DiscussionThreadList } from "@/components/discussion/thread-list";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { DISCUSSION_CATEGORIES, DISCUSSION_CATEGORY_LABELS } from "@/lib/constants";
import {
  DISCUSSION_SEARCH_MAX,
  type DiscussionFilters,
  discussionListHref,
  hasDiscussionFilters,
  newDiscussionHref,
  parseDiscussionFilters,
} from "@/lib/discussion";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { listDiscussionThreads } from "@/server/queries/discussion";

export const metadata: Metadata = { title: "Discussion" };

/** Request time, read outside of render so "2 h ago" lines up with the data. */
function requestTime(): Date {
  return new Date();
}

/** A plain GET form, so the search lives in the URL (the chips' filters ride along). */
function SearchForm({ filters }: { filters: DiscussionFilters }) {
  return (
    <form method="get" action="/discussion" role="search" className="flex min-w-0 gap-2">
      {filters.category && <input type="hidden" name="category" value={filters.category} />}
      {filters.unread && <input type="hidden" name="unread" value="1" />}
      {filters.mine && <input type="hidden" name="mine" value="1" />}
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
        <Input
          type="search"
          name="q"
          defaultValue={filters.q ?? ""}
          placeholder="Search titles"
          aria-label="Search discussion titles"
          maxLength={DISCUSSION_SEARCH_MAX}
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

/** The team-wide forum: everyone reads, starts discussions, and replies. */
export default async function DiscussionPage({ searchParams }: PageProps<"/discussion">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const filters = parseDiscussionFilters(sp);
  const list = await listDiscussionThreads(actor, filters, parsePage(sp.page));
  const removed = (Array.isArray(sp.removed) ? sp.removed[0] : sp.removed) === "1";
  const filtered = hasDiscussionFilters(filters);
  const now = requestTime();

  const startButton = (
    <ButtonLink href={newDiscussionHref(filters.category)}>
      <Plus className="size-4" aria-hidden />
      Start a discussion
    </ButtonLink>
  );
  const categoryChips = [
    { href: discussionListHref({ ...filters, category: undefined }), label: "All", active: !filters.category },
    ...DISCUSSION_CATEGORIES.map((c) => ({
      href: discussionListHref({ ...filters, category: c }),
      label: DISCUSSION_CATEGORY_LABELS[c],
      active: filters.category === c,
    })),
  ];
  const total = list?.total ?? 0;
  // Names the category, so it's clear what's filtered even when its chip is scrolled out of view.
  const count = `${total === 1 ? "1 discussion" : `${total.toLocaleString("en-US")} discussions`}${
    filters.category ? ` in ${DISCUSSION_CATEGORY_LABELS[filters.category]}` : ""
  }`;

  return (
    <>
      <PageHeader
        title="Discussion"
        description="Talk with the whole team: ideas, robot questions, and everything else. Everyone can read and reply."
        actions={startButton}
      />

      {/* Takes focus, so keyboard and screen-reader users hear it (instead of landing on <body>). */}
      {removed && (
        <div className="mb-4">
          <FocusAlert tone="success">Discussion deleted.</FocusAlert>
        </div>
      )}

      <div className="mb-4 space-y-3">
        {/* Keyed by the filters, so a chip or "Clear filters" (client navigations) resets the box too. */}
        <SearchForm key={JSON.stringify(filters)} filters={filters} />
        {/* Like /tasks: the chips and the toggles share a row from lg up. Flex gaps, not space-y: KeepChipInView adds
            no box, so a margin on it would do nothing. */}
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <KeepChipInView active={filters.category ?? "ALL"}>
            <FilterChips label="Filter by category" chips={categoryChips} className="lg:flex-1" />
          </KeepChipInView>
          <div className="flex flex-wrap gap-2">
            <ToggleChip href={discussionListHref({ ...filters, unread: !filters.unread })} label="Unread" active={filters.unread} />
            <ToggleChip href={discussionListHref({ ...filters, mine: !filters.mine })} label="Mine" active={filters.mine} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <p className="text-sm text-ink-500" aria-live="polite">
            {count}
          </p>
          {filtered && (
            <Link href="/discussion" className="inline-flex min-h-10 items-center text-sm font-medium text-brand-700 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </div>

      {!list || list.items.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title={filters.unread && !filters.q && !filters.mine && !filters.category ? "You're all caught up" : "No discussions match"}
              description={
                filters.unread && !filters.q && !filters.mine && !filters.category
                  ? "Nothing new since you last looked."
                  : "Try another category or search, or clear the filters."
              }
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <ButtonLink href="/discussion" variant="secondary">
                    Show all
                  </ButtonLink>
                  {startButton}
                </div>
              }
            />
          ) : (
            <EmptyState
              icon={MessagesSquare}
              title="No discussions yet"
              description="Start one: share an idea, ask the team something, or plan what's next."
              action={startButton}
            />
          )}
        </Card>
      ) : (
        <>
          <DiscussionThreadList threads={list.items} now={now} timeZone={env.teamTimezone} />
          <Pagination page={list.page} pageCount={list.pageCount} hrefFor={(page) => discussionListHref(filters, page)} />
        </>
      )}
    </>
  );
}
