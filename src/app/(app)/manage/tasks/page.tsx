import { FolderKanban, Plus, SearchX, Tags } from "lucide-react";
import type { Metadata } from "next";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { TaskListItem } from "@/components/tasks/task-list-item";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { todayInTimezone } from "@/lib/dates";
import { requireStaffUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canCreateTask, hasAllScope } from "@/server/permissions";
import { listManagedTasks, parseSubteamFilter, type SubteamFilter, type TaskListView } from "@/server/queries/tasks";

export const metadata: Metadata = { title: "Tasks" };

const VIEWS: { value: TaskListView; label: string }[] = [
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
  { value: "all", label: "All" },
];

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

interface Filters {
  view: TaskListView;
  subteam?: SubteamFilter;
  mine: boolean;
  page: number;
}

function hrefFor(f: Filters): string {
  const sp = new URLSearchParams();
  if (f.view !== "upcoming") sp.set("view", f.view);
  if (f.subteam) sp.set("subteam", f.subteam);
  if (f.mine) sp.set("mine", "1");
  if (f.page > 1) sp.set("page", String(f.page));
  const qs = sp.toString();
  return qs ? `/manage/tasks?${qs}` : "/manage/tasks";
}

export default async function ManageTasksPage({ searchParams }: PageProps<"/manage/tasks">) {
  const actor = await requireStaffUser();
  const sp = await searchParams;
  const allScope = hasAllScope(actor);
  const view = VIEWS.find((v) => v.value === first(sp.view))?.value ?? "upcoming";
  const filters: Filters = {
    view,
    subteam: allScope ? parseSubteamFilter(sp.subteam) : undefined,
    mine: first(sp.mine) === "1",
    page: parsePage(sp.page),
  };
  const today = todayInTimezone(env.teamTimezone);
  const list = await listManagedTasks(actor, { ...filters, today });
  const filtered = !!filters.subteam || filters.mine;

  const subteamChips = [
    { href: hrefFor({ ...filters, subteam: undefined, page: 1 }), label: "All subteams", active: !filters.subteam },
    ...SUBTEAMS.map((s) => ({ href: hrefFor({ ...filters, subteam: s, page: 1 }), label: SUBTEAM_LABELS[s], active: filters.subteam === s })),
    { href: hrefFor({ ...filters, subteam: "TEAM", page: 1 }), label: "Whole team", active: filters.subteam === "TEAM" },
  ];

  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          allScope
            ? "Assign work to the team and track it."
            : canCreateTask(actor, null)
              ? "Assign work to your subteam or the whole team and track it."
              : "Assign work to your subteam and track it."
        }
        actions={
          <>
            <ButtonLink href="/manage/categories" variant="secondary">
              <Tags className="size-4" aria-hidden />
              Categories
            </ButtonLink>
            <ButtonLink href="/manage/tasks/new">
              <Plus className="size-4" aria-hidden />
              New task
            </ButtonLink>
          </>
        }
      />

      <LinkTabs
        className="mb-4"
        tabs={VIEWS.map((v) => ({ href: hrefFor({ ...filters, view: v.value, page: 1 }), label: v.label, active: v.value === view }))}
      />

      <div className="mb-4 space-y-2 sm:flex sm:items-center sm:gap-2 sm:space-y-0">
        {allScope && <FilterChips label="Filter by subteam" chips={subteamChips} className="sm:flex-1" />}
        <div className="flex">
          <ToggleChip href={hrefFor({ ...filters, mine: !filters.mine, page: 1 })} label="Created by me" active={filters.mine} />
        </div>
      </div>

      {list.tasks.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="No tasks match these filters"
              description="Try another subteam or turn off “Created by me”."
              action={
                <ButtonLink href={hrefFor({ view, mine: false, page: 1 })} variant="secondary">
                  Clear filters
                </ButtonLink>
              }
            />
          ) : view === "past" ? (
            <EmptyState
              icon={FolderKanban}
              title="No past tasks yet"
              description="Tasks move here after their due date, or once they're marked finished."
            />
          ) : (
            <EmptyState
              icon={FolderKanban}
              title={view === "upcoming" ? "Nothing coming up" : "No tasks yet"}
              description="Create a task and it lands on everyone's checklist right away."
              action={
                <ButtonLink href="/manage/tasks/new">
                  <Plus className="size-4" aria-hidden />
                  New task
                </ButtonLink>
              }
            />
          )}
        </Card>
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-500">
            {list.total} {list.total === 1 ? "task" : "tasks"}
          </p>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-ink-100">
              {list.tasks.map((task) => (
                <li key={task.id}>
                  <TaskListItem task={task} today={today} />
                </li>
              ))}
            </ul>
          </Card>
          <Pagination page={list.page} pageCount={list.pageCount} hrefFor={(page) => hrefFor({ ...filters, page })} />
        </>
      )}
    </>
  );
}
