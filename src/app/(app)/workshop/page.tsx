import { ClipboardCheck, Globe, PencilRuler, Plus, SearchX } from "lucide-react";
import type { Metadata } from "next";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { type LinkTab, LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { WORKSHOP_SITE_URL } from "@/components/workshop/kinds";
import { WorkshopGrid } from "@/components/workshop/workshop-grid";
import { WORKSHOP_KIND_LABELS, WORKSHOP_KINDS, type WorkshopKindValue } from "@/lib/workshop";
import { requireActiveUser } from "@/server/auth/session";
import { listWorkshopProjects, type WorkshopView } from "@/server/queries/workshop";

export const metadata: Metadata = { title: "Workshop" };

interface Filters {
  view: WorkshopView;
  kind: WorkshopKindValue | null;
  mine: boolean;
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function parseView(v: string | undefined): WorkshopView {
  return v === "drafts" || v === "review" ? v : "website";
}

function parseKind(v: string | undefined): WorkshopKindValue | null {
  const upper = v?.toUpperCase();
  return WORKSHOP_KINDS.find((k) => k === upper) ?? null;
}

function hrefFor(f: Filters): string {
  const sp = new URLSearchParams();
  if (f.view !== "website") sp.set("view", f.view);
  if (f.kind) sp.set("kind", f.kind.toLowerCase());
  if (f.mine) sp.set("who", "mine");
  const qs = sp.toString();
  return qs ? `/workshop?${qs}` : "/workshop";
}

const addButton = (
  <ButtonLink href="/workshop/new">
    <Plus className="size-4" aria-hidden />
    Add a project
  </ButtonLink>
);

const siteLink = "font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800";

function Empty({ filters, reviewer }: { filters: Filters; reviewer: boolean }) {
  if (filters.kind !== null || filters.mine) {
    return (
      <EmptyState
        icon={SearchX}
        title="No projects match"
        description={filters.mine ? "Turn off Mine, or pick another kind, to see more." : "Pick another kind to see more."}
        action={
          <ButtonLink href={hrefFor({ ...filters, kind: null, mine: false })} variant="secondary">
            Show all projects
          </ButtonLink>
        }
      />
    );
  }
  if (filters.view === "review") {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Nothing waiting for approval"
        description="When someone sends a project for approval, it shows up here for you to approve or send back."
      />
    );
  }
  if (filters.view === "drafts") {
    return (
      <EmptyState
        icon={PencilRuler}
        title="No drafts"
        description={
          reviewer
            ? "Drafts, projects waiting for approval, and ones sent back for changes show up here."
            : "Projects you add or are credited on stay here until they're approved for the team website."
        }
        action={addButton}
      />
    );
  }
  return (
    <EmptyState
      icon={Globe}
      title="Nothing on the website yet"
      description="Add a part, program, or build with a photo, then send it for approval."
      action={addButton}
    />
  );
}

/** What the team designs and builds. Everyone adds projects; approved ones show on the team website. */
export default async function WorkshopPage({ searchParams }: PageProps<"/workshop">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const filters: Filters = { view: parseView(first(sp.view)), kind: parseKind(first(sp.kind)), mine: first(sp.who) === "mine" };
  const list = await listWorkshopProjects(actor, filters);
  // A member's "?view=review" shows the website tab.
  if (filters.view === "review" && !list.reviewer) filters.view = "website";
  const removed = first(sp.removed) === "1";
  // Someone only credited on a project that isn't on the website took their own name off it (updateWorkshopProjectAction).
  const left = first(sp.left) === "1";

  const tabs: LinkTab[] = [
    { href: hrefFor({ ...filters, view: "website" }), label: "On the website", active: filters.view === "website", count: list.counts.website },
    { href: hrefFor({ ...filters, view: "drafts" }), label: "Not on the website yet", active: filters.view === "drafts", count: list.counts.drafts },
  ];
  if (list.reviewer) {
    tabs.push({
      href: hrefFor({ ...filters, view: "review" }),
      label: "Waiting for approval",
      active: filters.view === "review",
      count: list.counts.review,
      tone: "alert",
    });
  }

  return (
    <>
      <PageHeader
        title="Workshop"
        description={
          <>
            The parts, software, and builds the team makes. Approved ones show on the{" "}
            <a href={WORKSHOP_SITE_URL} target="_blank" rel="noopener noreferrer" className={siteLink}>
              team website
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            .
          </>
        }
        actions={addButton}
      />

      {/* Takes focus, so keyboard and screen-reader users hear it (instead of landing on <body>). */}
      {removed && (
        <div className="mb-4">
          <FocusAlert tone="success">Project removed.</FocusAlert>
        </div>
      )}
      {left && (
        <div className="mb-4">
          <FocusAlert tone="success">Your name is off that project. Only the people on it and leaders can see it now.</FocusAlert>
        </div>
      )}

      <LinkTabs className="mb-4" tabs={tabs} />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <FilterChips
          label="Kind of project"
          className="min-w-0"
          chips={[
            { href: hrefFor({ ...filters, kind: null }), label: "All", active: filters.kind === null },
            ...WORKSHOP_KINDS.map((k) => ({ href: hrefFor({ ...filters, kind: k }), label: WORKSHOP_KIND_LABELS[k], active: filters.kind === k })),
          ]}
        />
        <div className="flex">
          <ToggleChip href={hrefFor({ ...filters, mine: !filters.mine })} label="Mine" active={filters.mine} />
        </div>
      </div>

      {list.items.length === 0 ? (
        <Card>
          <Empty filters={filters} reviewer={list.reviewer} />
        </Card>
      ) : (
        <WorkshopGrid projects={list.items} />
      )}
    </>
  );
}
