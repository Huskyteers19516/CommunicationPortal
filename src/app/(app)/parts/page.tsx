import { PackageCheck, Plus, Printer, SearchX } from "lucide-react";
import type { Metadata } from "next";
import { PartsList } from "@/components/parts/parts-list";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import type { PartProcess } from "@/generated/prisma/enums";
import { PART_PROCESS_LABELS, PART_PROCESSES } from "@/lib/constants";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getPartsQueue, PARTS_WHO, type PartsCounts, type PartsView, type PartsWho } from "@/server/queries/parts";
import { getPortalPhotoMap, photoIdsFor } from "@/server/queries/user-photos";

export const metadata: Metadata = { title: "Parts queue" };

interface Filters {
  view: PartsView;
  process?: PartProcess;
  who?: PartsWho;
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function hrefFor(f: Filters): string {
  const sp = new URLSearchParams();
  if (f.view === "done") sp.set("view", "done");
  if (f.process) sp.set("process", f.process);
  if (f.who) sp.set("who", f.who);
  const qs = sp.toString();
  return qs ? `/parts?${qs}` : "/parts";
}

/** "3D-printed parts", "laser-cut parts"… for the empty states. */
const PROCESS_NOUNS: Record<PartProcess, string> = {
  PRINT_3D: "3D-printed parts",
  LASER_CUT: "laser-cut parts",
  CNC: "CNC parts",
  CUT: "cut parts",
  MACHINE: "machined parts",
  OTHER: "“Other” parts",
};

/** What an empty, filtered result means for exactly these filters. */
function filteredEmptyText(f: Filters): string {
  const done = f.view === "done";
  const noun = f.process ? PROCESS_NOUNS[f.process] : "parts";
  if (f.who === "making") return done ? `You haven't finished any ${noun} yet.` : `You aren't making any ${noun} right now.`;
  if (f.who === "asked") return done ? `None of the ${noun} you asked for are done yet.` : `You haven't asked for any ${noun} in the queue.`;
  return done ? `No ${noun} are done yet.` : `No ${noun} in the queue right now.`;
}

/** "3 up for grabs · 1 being made · 2 done this week", counting only what the filters match. */
function countsText(counts: PartsCounts, f: Filters): string {
  if (f.who === "making") return `You're making ${counts.beingMade} · you finished ${counts.doneThisWeek} this week`;
  return `${counts.upForGrabs} up for grabs · ${counts.beingMade} being made · ${counts.doneThisWeek} done this week`;
}

/** Request time, read outside of render so relative labels line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

export default async function PartsQueuePage({ searchParams }: PageProps<"/parts">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const filters: Filters = {
    view: first(sp.view) === "done" ? "done" : "queue",
    process: PART_PROCESSES.find((p) => p === first(sp.process)),
    who: PARTS_WHO.find((w) => w === first(sp.who)),
  };
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone, now);
  const queue = await getPartsQueue(actor, { ...filters, today, now });
  const photoIds = photoIdsFor(await getPortalPhotoMap(), queue.items.map((p) => p.claimedBy?.id));
  const { counts } = queue;
  const filtered = !!filters.process || !!filters.who;

  const processChips = [
    { href: hrefFor({ ...filters, process: undefined }), label: "All", active: !filters.process },
    ...PART_PROCESSES.map((p) => ({ href: hrefFor({ ...filters, process: p }), label: PART_PROCESS_LABELS[p], active: filters.process === p })),
  ];

  const empty = filtered ? (
    <EmptyState
      icon={SearchX}
      title="No parts match these filters"
      description={filteredEmptyText(filters)}
      action={
        <ButtonLink href={hrefFor({ view: filters.view })} variant="secondary">
          Clear filters
        </ButtonLink>
      }
    />
  ) : filters.view === "done" ? (
    <EmptyState icon={PackageCheck} title="Nothing finished yet" description="Parts show up here once someone marks them done." />
  ) : (
    <EmptyState
      icon={Printer}
      title="The queue is empty"
      description="Need something printed, cut, or machined? Add it and someone will grab it."
      action={
        <ButtonLink href="/parts/new">
          <Plus className="size-4" aria-hidden />
          Add a part
        </ButtonLink>
      }
    />
  );

  return (
    <>
      <PageHeader
        title="Parts queue"
        description="What needs to be printed, cut, or machined — most important first. Grab one and make it."
        actions={
          <ButtonLink href="/parts/new">
            <Plus className="size-4" aria-hidden />
            Add a part
          </ButtonLink>
        }
      />

      {/* Tabs, filters, and cards share one column, so the chips line up with the cards on wide screens. */}
      <div className="max-w-3xl">
        <LinkTabs
          className="mb-4"
          tabs={[
            { href: hrefFor({ ...filters, view: "queue" }), label: "Queue", active: filters.view === "queue", count: counts.upForGrabs + counts.beingMade },
            { href: hrefFor({ ...filters, view: "done" }), label: "Done", active: filters.view === "done", count: counts.doneTotal },
          ]}
        />

        <div className="mb-3 space-y-2">
          <FilterChips label="Filter by how it's made" chips={processChips} />
          <div className="flex flex-wrap gap-2">
            <ToggleChip
              href={hrefFor({ ...filters, who: filters.who === "making" ? undefined : "making" })}
              label={filters.view === "done" ? "Made by me" : "I'm making"}
              active={filters.who === "making"}
            />
            <ToggleChip
              href={hrefFor({ ...filters, who: filters.who === "asked" ? undefined : "asked" })}
              label="Asked by me"
              active={filters.who === "asked"}
            />
          </div>
        </div>

        <p className="mb-4 text-sm text-ink-600">{countsText(counts, filters)}</p>

        {queue.truncated && (
          <Alert className="mb-4">
            {filters.view === "done"
              ? `Showing the ${queue.limit} most recently finished parts.`
              : `Showing the first ${queue.limit} parts in the queue.`}
          </Alert>
        )}

        <PartsList
          parts={queue.items}
          view={filters.view}
          today={today}
          nowIso={now.toISOString()}
          timeZone={timeZone}
          queueLength={queue.queueLength}
          photoIds={photoIds}
          empty={<Card>{empty}</Card>}
        />
      </div>
    </>
  );
}
