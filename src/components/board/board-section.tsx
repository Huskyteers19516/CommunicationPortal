import { ListPlus } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { DateOnly } from "@/lib/dates";
import type { BoardSection, BoardTask } from "@/server/queries/board";
import { BoardTaskCard } from "./board-task-card";
import { BoardSectionHeader } from "./section-header";

function TaskList({ tasks, today, wide }: { tasks: BoardTask[]; today: DateOnly; wide: boolean }) {
  return (
    <ul className={cn("grid gap-2", wide && "md:grid-cols-2 xl:grid-cols-3")}>
      {tasks.map((task) => (
        <li key={task.id} className="min-w-0">
          <BoardTaskCard task={task} today={today} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One subteam (or the whole team) on the Task dashboard: its categories, each with its tasks, then
 * tasks without a category. `wide` lays tasks out in columns (whole-team row, single-subteam view).
 */
export function BoardSectionView({
  section,
  today,
  wide = false,
  emptyText,
  canAddTasks,
  reserveControlsRow = false,
  className,
}: {
  section: BoardSection;
  today: DateOnly;
  wide?: boolean;
  /** Shown when there is nothing in the section. */
  emptyText: string;
  /** Plain active view: people who create tasks here get "new task here" per category, managers the "no categories yet" hint. */
  canAddTasks: boolean;
  /** 3-column layout: keep room for a row of manager controls so the columns line up. */
  reserveControlsRow?: boolean;
  className?: string;
}) {
  const headingId = `section-${section.key}`;
  const manage = section.canManage && canAddTasks;
  const addTasks = section.canCreateTasks && canAddTasks;
  const hasGroups = section.categories.length > 0;
  const nothing = !hasGroups && section.uncategorized.length === 0;

  return (
    <section
      id={section.key}
      aria-labelledby={headingId}
      className={cn("min-w-0 scroll-mt-20 rounded-xl border border-ink-200 bg-ink-50/70 p-3 sm:p-4", className)}
    >
      <BoardSectionHeader
        headingId={headingId}
        sectionKey={section.key}
        label={section.label}
        taskCount={section.taskCount}
        canManage={section.canManage}
        canCreateTasks={section.canCreateTasks}
        reserveControlsRow={reserveControlsRow}
      />

      {nothing ? (
        <div className="mt-3 rounded-lg border border-dashed border-ink-200 bg-white/60 px-3 py-4 text-center text-sm text-ink-500">
          <p>{emptyText}</p>
          {manage && <p className="mt-1">No categories yet — add one with “Category”, like Intake or CAD.</p>}
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          {section.categories.map((category) => {
            const id = `category-${category.id}`;
            return (
              <div key={category.id} role="group" aria-labelledby={id} className="min-w-0">
                <div className="mb-1.5 flex min-h-10 items-start justify-between gap-2">
                  {/* Names can be one 40-character word: let them wrap, never push the count or button out. */}
                  <h3 id={id} className="flex min-w-0 items-baseline gap-2 py-2.5 text-sm font-semibold leading-5 text-ink-700">
                    <span className="min-w-0 wrap-anywhere">{category.name}</span>
                    <span className="shrink-0 text-xs font-normal tabular-nums text-ink-500">{category.tasks.length}</span>
                  </h3>
                  {addTasks && (
                    <Link
                      href={`/manage/tasks/new?subteam=${section.key}&category=${encodeURIComponent(category.id)}`}
                      aria-label={`New task in ${category.name}`}
                      title="New task in this category"
                      className="-mr-1 inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-white hover:text-brand-700"
                    >
                      <ListPlus className="size-5" aria-hidden />
                    </Link>
                  )}
                </div>
                {category.tasks.length > 0 ? (
                  <TaskList tasks={category.tasks} today={today} wide={wide} />
                ) : (
                  <p className="rounded-lg border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-500">No tasks here yet.</p>
                )}
              </div>
            );
          })}
          {section.uncategorized.length > 0 && (
            <div role={hasGroups ? "group" : undefined} aria-labelledby={hasGroups ? `${headingId}-other` : undefined} className="min-w-0">
              {hasGroups && (
                <h3 id={`${headingId}-other`} className="mb-1.5 flex min-h-10 items-center gap-2 text-sm font-semibold text-ink-700">
                  Other tasks
                  <span className="text-xs font-normal tabular-nums text-ink-500">{section.uncategorized.length}</span>
                </h3>
              )}
              <TaskList tasks={section.uncategorized} today={today} wide={wide} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
