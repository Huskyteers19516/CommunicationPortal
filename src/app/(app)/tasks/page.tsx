import { Plus, SearchX } from "lucide-react";
import type { Metadata } from "next";
import { BoardSectionView } from "@/components/board/board-section";
import { PublicStatusLegend } from "@/components/board/people-chips";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canAccessManage } from "@/server/permissions";
import {
  BOARD_SECTION_KEYS,
  type BoardSectionKey,
  type BoardView,
  getTaskBoard,
  parseBoardSection,
  sectionLabel,
} from "@/server/queries/board";

export const metadata: Metadata = { title: "Task dashboard" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

interface Filters {
  view: BoardView;
  subteam?: BoardSectionKey;
  open: boolean;
  mine: boolean;
}

/** "Business tasks" / "whole-team tasks" / "tasks". */
function tasksIn(subteam: BoardSectionKey | undefined): string {
  if (!subteam) return "tasks";
  return subteam === "TEAM" ? "whole-team tasks" : `${sectionLabel(subteam)} tasks`;
}

/** What the empty result means for exactly these filters. */
function emptyResult(f: Filters): { title: string; description: string } {
  const tasks = tasksIn(f.subteam);
  if (!f.open && !f.mine) {
    return {
      title: `No past ${tasks} yet`,
      description: "Finished tasks, and tasks due more than 30 days ago, show up here.",
    };
  }
  let description: string;
  if (f.open && f.mine) description = `You haven't signed up for any open ${tasks}.`;
  else if (f.open) {
    description = f.subteam
      ? `No ${tasks} are open for you to sign up for right now.`
      : "Nothing is open for you to sign up for right now. Leaders open tasks for sign-up when they create them.";
  } else description = `You're not on any ${f.view === "past" ? "past " : ""}${tasks}${f.view === "past" ? "" : " right now"}.`;
  return { title: "No tasks match these filters", description };
}

/** Where each section sits in the 3-column layout (xl), whatever order phones get. */
const XL_ORDER: Record<BoardSectionKey, string> = {
  SOFTWARE: "xl:order-1",
  BUILD: "xl:order-2",
  BUSINESS: "xl:order-3",
  TEAM: "xl:order-4 xl:col-span-3",
};

function hrefFor(f: Filters): string {
  const sp = new URLSearchParams();
  if (f.view !== "active") sp.set("view", f.view);
  if (f.subteam) sp.set("subteam", f.subteam);
  if (f.open) sp.set("open", "1");
  if (f.mine) sp.set("mine", "1");
  const qs = sp.toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}

export default async function TaskDashboardPage({ searchParams }: PageProps<"/tasks">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const view: BoardView = first(sp.view) === "past" ? "past" : "active";
  const filters: Filters = {
    view,
    subteam: parseBoardSection(sp.subteam),
    // Past tasks can't be signed up for, so "Open for sign-up" only applies to the active view.
    open: view === "active" && first(sp.open) === "1",
    mine: first(sp.mine) === "1",
  };
  const today = todayInTimezone(env.teamTimezone);
  const board = await getTaskBoard(actor, { ...filters, today });
  const filtered = filters.open || filters.mine;
  const plain = filters.view === "active" && !filtered;

  const subteamChips = [
    { href: hrefFor({ ...filters, subteam: undefined }), label: "All", active: !filters.subteam },
    ...BOARD_SECTION_KEYS.map((key) => ({
      href: hrefFor({ ...filters, subteam: key }),
      label: sectionLabel(key),
      active: filters.subteam === key,
    })),
  ];

  const emptyText =
    filters.view === "past"
      ? "No past tasks."
      : filtered
        ? "Nothing here matches these filters."
        : "No tasks right now.";

  const empty = emptyResult(filters);

  // Phones stack the sections, so the viewer's own subteam (then whole-team tasks) comes first instead
  // of a Build member scrolling past all of Software. Wide screens keep fixed Software/Build/Business
  // columns (XL_ORDER), so columns never jump around. No subteam (captain, mentors): the usual order.
  const own: BoardSectionKey | null = actor.subteam;
  const ordered = own
    ? [
        ...board.sections.filter((s) => s.key === own),
        ...board.sections.filter((s) => s.key === "TEAM"),
        ...board.sections.filter((s) => s.key !== own && s.key !== "TEAM"),
      ]
    : board.sections;
  // A manager's column has a row of controls; the others keep that room so first categories line up.
  const alignColumns = board.sections.some((s) => s.key !== "TEAM" && s.canManage);

  return (
    <>
      <PageHeader
        title="Task dashboard"
        description="Every subteam's tasks and who's on them."
        actions={
          canAccessManage(actor) && (
            <ButtonLink href="/manage/tasks/new">
              <Plus className="size-4" aria-hidden />
              New task
            </ButtonLink>
          )
        }
      />

      <LinkTabs
        className="mb-4"
        tabs={[
          { href: hrefFor({ ...filters, view: "active" }), label: "Active", active: filters.view === "active" },
          { href: hrefFor({ ...filters, view: "past" }), label: "Past", active: filters.view === "past" },
        ]}
      />

      <div className="mb-3 space-y-2 lg:flex lg:items-center lg:gap-2 lg:space-y-0">
        <FilterChips label="Filter by subteam" chips={subteamChips} className="lg:flex-1" />
        <div className="flex flex-wrap gap-2">
          {filters.view === "active" && (
            <ToggleChip href={hrefFor({ ...filters, open: !filters.open })} label="Open for sign-up" active={filters.open} />
          )}
          <ToggleChip href={hrefFor({ ...filters, mine: !filters.mine })} label="Mine" active={filters.mine} />
        </div>
      </div>

      {/* Finished tasks (the only ones with "closed" people) are always on the Past tab. */}
      <PublicStatusLegend className="mb-4" showClosed={filters.view === "past"} />

      {board.truncated && (
        <Alert className="mb-4">
          {filters.view === "past"
            ? `Showing the ${board.limit} most recent past tasks.`
            : `Showing the first ${board.limit} tasks. Pick a subteam to see the rest.`}
        </Alert>
      )}

      {board.total === 0 && (filtered || filters.view === "past") ? (
        <Card>
          <EmptyState
            icon={SearchX}
            title={empty.title}
            description={empty.description}
            action={
              (filtered || filters.subteam) && (
                <div className="flex flex-wrap justify-center gap-2">
                  {filtered && (
                    <ButtonLink href={hrefFor({ ...filters, open: false, mine: false })} variant="secondary">
                      Clear filters
                    </ButtonLink>
                  )}
                  {filters.subteam && (
                    <ButtonLink href={hrefFor({ ...filters, subteam: undefined })} variant="secondary">
                      See all subteams
                    </ButtonLink>
                  )}
                </div>
              )
            }
          />
        </Card>
      ) : filters.subteam ? (
        <BoardSectionView section={board.sections[0]} today={today} wide emptyText={emptyText} canAddTasks={plain} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          {ordered.map((section) => (
            <BoardSectionView
              key={section.key}
              section={section}
              today={today}
              wide={section.key === "TEAM"}
              emptyText={emptyText}
              canAddTasks={plain}
              reserveControlsRow={alignColumns && section.key !== "TEAM"}
              className={XL_ORDER[section.key]}
            />
          ))}
        </div>
      )}
    </>
  );
}
