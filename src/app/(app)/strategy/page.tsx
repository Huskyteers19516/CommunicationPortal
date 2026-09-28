import { Plus, SearchX, Swords } from "lucide-react";
import type { Metadata } from "next";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { PathPlanner } from "@/components/strategy/path-planner";
import { StrategyList } from "@/components/strategy/strategy-list";
import { StrategyTabs } from "@/components/strategy/strategy-tabs";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { STRATEGY_KIND_LABELS, STRATEGY_KINDS, type StrategyKind } from "@/lib/constants";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getStrategyTabCounts } from "@/server/queries/league-teams";
import { listStrategies } from "@/server/queries/strategy";

export const metadata: Metadata = { title: "Strategy" };

interface Filters {
  kind?: StrategyKind;
  mine: boolean;
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function hrefFor(f: Filters, page = 1): string {
  const sp = new URLSearchParams();
  if (f.kind) sp.set("kind", f.kind);
  if (f.mine) sp.set("who", "mine");
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  // Back to the list, not the planner at the top of the page.
  return `${qs ? `/strategy?${qs}` : "/strategy"}#strategies`;
}

/** "Add a strategy", starting on the kind being looked at. */
function addHref(kind?: StrategyKind): string {
  return kind ? `/strategy/new?kind=${kind}` : "/strategy/new";
}

/** Request time, read outside of render so "updated 3 h ago" lines up with the data. */
function requestTime(): Date {
  return new Date();
}

/** The Pedro Pathing planner, and the team's strategies (everyone sees them and can add one). */
export default async function StrategyPage({ searchParams }: PageProps<"/strategy">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const filters: Filters = {
    kind: STRATEGY_KINDS.find((k) => k === first(sp.kind)),
    mine: first(sp.who) === "mine",
  };
  const [list, counts] = await Promise.all([listStrategies(actor, { ...filters, page: parsePage(sp.page) }), getStrategyTabCounts(actor)]);
  const removed = first(sp.removed) === "1";
  const now = requestTime();
  const filtered = !!filters.kind || filters.mine;

  const addButton = (
    <ButtonLink href={addHref(filters.kind)}>
      <Plus className="size-4" aria-hidden />
      Add a strategy
    </ButtonLink>
  );

  const kindChips = [
    { href: hrefFor({ ...filters, kind: undefined }), label: "All", active: !filters.kind },
    ...STRATEGY_KINDS.map((k) => ({ href: hrefFor({ ...filters, kind: k }), label: STRATEGY_KIND_LABELS[k], active: filters.kind === k })),
  ];

  return (
    <>
      <PageHeader
        title="Strategy"
        description="Plan autonomous paths, keep the team's game plans in one place, and track how other teams play."
        actions={addButton}
      />

      <StrategyTabs active="ours" counts={counts} />

      {/* Takes focus, so keyboard and screen-reader users hear it (instead of landing on <body>). */}
      {removed && (
        <div className="mb-4">
          <FocusAlert tone="success">Strategy removed.</FocusAlert>
        </div>
      )}

      <PathPlanner
        skipTo={{ href: "#strategies", label: "Skip the planner" }}
        hint="Paths saved inside the planner stay in this browser, and only here (not in a new tab). To share one: in the planner, open the Save menu (the disk icon, top right) → Save As → Confirm. That downloads a .pp file: add it to a strategy below."
      />

      <section id="strategies" aria-labelledby="strategies-title" className="mt-8 scroll-mt-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h2 id="strategies-title" className="text-lg font-semibold text-ink-900">
              Our strategies
            </h2>
            <p className="text-sm text-ink-500">Autos, match plans, scouting notes… Pinned ones first, then the newest.</p>
          </div>
        </div>

        <div className="mb-4 space-y-2">
          <FilterChips label="Filter by kind" chips={kindChips} />
          <div className="flex flex-wrap items-center gap-2">
            <ToggleChip href={hrefFor({ ...filters, mine: !filters.mine })} label="Mine" active={filters.mine} />
            {list && (
              <p className="text-sm text-ink-500" aria-live="polite">
                {list.total === 1 ? "1 strategy" : `${list.total} strategies`}
              </p>
            )}
          </div>
        </div>

        {!list || list.items.length === 0 ? (
          <Card>
            {filtered ? (
              <EmptyState
                icon={SearchX}
                title="No strategies match"
                description={
                  filters.mine
                    ? `You haven't added any${filters.kind ? ` ${STRATEGY_KIND_LABELS[filters.kind].toLowerCase()}` : ""} strategies yet.`
                    : `No ${STRATEGY_KIND_LABELS[filters.kind!].toLowerCase()} strategies yet.`
                }
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <ButtonLink href={hrefFor({ mine: false })} variant="secondary">
                      Show all
                    </ButtonLink>
                    {addButton}
                  </div>
                }
              />
            ) : (
              <EmptyState
                icon={Swords}
                title="No strategies yet"
                description="Add an auto path from the planner, a match plan, or scouting notes so the whole team can find them."
                action={addButton}
              />
            )}
          </Card>
        ) : (
          <>
            <StrategyList strategies={list.items} now={now} timeZone={env.teamTimezone} />
            <Pagination page={list.page} pageCount={list.pageCount} hrefFor={(page) => hrefFor(filters, page)} />
          </>
        )}
      </section>
    </>
  );
}
