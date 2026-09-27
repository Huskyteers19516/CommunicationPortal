import { CalendarClock, GalleryVerticalEnd, Images, Plus } from "lucide-react";
import type { Metadata } from "next";
import { PosterGrid } from "@/components/posters/poster-grid";
import { ToggleChip } from "@/components/tasks/filter-chips";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { listPosters, type PosterView } from "@/server/queries/posters";

export const metadata: Metadata = { title: "Posters" };

interface Filters {
  view: PosterView;
  mine: boolean;
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function hrefFor(f: Filters, page = 1): string {
  const sp = new URLSearchParams();
  if (f.view === "past") sp.set("view", "past");
  if (f.mine) sp.set("who", "mine");
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/posters?${qs}` : "/posters";
}

const addButton = (
  <ButtonLink href="/posters/new">
    <Plus className="size-4" aria-hidden />
    Add a poster
  </ButtonLink>
);

function Empty({ filters }: { filters: Filters }) {
  if (filters.mine) {
    return (
      <EmptyState
        icon={Images}
        title={filters.view === "past" ? "None of your posters are past" : "You haven't added any posters"}
        description={
          filters.view === "past" ? "Your posters move here after their event date." : "Posters you add show up here."
        }
        action={
          <ButtonLink href={hrefFor({ ...filters, mine: false })} variant="secondary">
            Show everyone&apos;s
          </ButtonLink>
        }
      />
    );
  }
  if (filters.view === "past") {
    return (
      <EmptyState icon={CalendarClock} title="No past posters" description="Posters move here after their event date." />
    );
  }
  return (
    <EmptyState
      icon={GalleryVerticalEnd}
      title="No posters yet"
      description="Add the flyer for a demo, recruiting, or a fundraiser so the whole team can find it."
      action={addButton}
    />
  );
}

/** The team's posters and flyers: everyone sees them and can add one. */
export default async function PostersPage({ searchParams }: PageProps<"/posters">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const filters: Filters = { view: first(sp.view) === "past" ? "past" : "upcoming", mine: first(sp.who) === "mine" };
  const today = todayInTimezone(env.teamTimezone);
  const list = await listPosters(actor, { ...filters, today, page: parsePage(sp.page) });
  const removed = first(sp.removed) === "1";

  return (
    <>
      <PageHeader
        title="Posters"
        description="Flyers and posters for demos, recruiting, and events. Add yours so everyone can find them."
        actions={addButton}
      />

      {/* Takes focus, so keyboard and screen-reader users hear it (instead of landing on <body>). */}
      {removed && (
        <div className="mb-4">
          <FocusAlert tone="success">Poster removed.</FocusAlert>
        </div>
      )}

      <LinkTabs
        className="mb-4"
        tabs={[
          { href: hrefFor({ ...filters, view: "upcoming" }), label: "Upcoming", active: filters.view === "upcoming", count: list?.counts.upcoming },
          { href: hrefFor({ ...filters, view: "past" }), label: "Past", active: filters.view === "past", count: list?.counts.past },
        ]}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ToggleChip href={hrefFor({ ...filters, mine: !filters.mine })} label="Added by me" active={filters.mine} />
        {filters.view === "upcoming" && <p className="text-sm text-ink-500">Coming up, and posters without a date.</p>}
      </div>

      {!list || list.items.length === 0 ? (
        <Card>
          <Empty filters={filters} />
        </Card>
      ) : (
        <>
          <PosterGrid posters={list.items} today={today} />
          <Pagination page={list.page} pageCount={list.pageCount} hrefFor={(page) => hrefFor(filters, page)} />
        </>
      )}
    </>
  );
}
