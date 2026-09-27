import type { Metadata } from "next";
import { BackLink } from "@/components/tasks/back-link";
import { TaskForm } from "@/components/tasks/task-form";
import { PageHeader } from "@/components/ui/page-header";
import type { Subteam } from "@/generated/prisma/enums";
import { SUBTEAMS } from "@/lib/constants";
import { addDays, todayInTimezone } from "@/lib/dates";
import { requireStaffUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getTaskFormCategories } from "@/server/queries/categories";
import { getAssignableUsers, getTaskDuplicate, getTaskFormOptions } from "@/server/queries/tasks";
import { DUE_DATE_MAX_FUTURE_DAYS, DUE_DATE_MAX_PAST_DAYS } from "@/server/services/tasks";
import { createTaskAction } from "../actions";

export const metadata: Metadata = { title: "New task" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function NewTaskPage({ searchParams }: PageProps<"/manage/tasks/new">) {
  const actor = await requireStaffUser();
  const sp = await searchParams;
  const from = typeof sp.from === "string" ? sp.from : undefined;
  const today = todayInTimezone(env.teamTimezone);
  const options = getTaskFormOptions(actor);
  // ?from=<taskId> copies a task the actor manages ("Duplicate"); anything else is ignored.
  const [groups, copy, categories] = await Promise.all([
    getAssignableUsers(actor),
    from ? getTaskDuplicate(actor, from, { today }) : null,
    getTaskFormCategories(actor),
  ]);

  // ?subteam=BUILD|TEAM&category=<id> (the dashboard's "+" buttons): only subteams and categories the actor may use.
  const subteamParam = first(sp.subteam);
  const wanted: "" | Subteam | undefined = subteamParam === "TEAM" ? "" : SUBTEAMS.find((s) => s === subteamParam);
  const subteam = wanted !== undefined && options.subteams.some((o) => o.value === wanted) ? wanted : options.defaultSubteam;
  const categoryParam = first(sp.category);
  const categoryId = categoryParam && categories[subteam]?.some((c) => c.id === categoryParam) ? categoryParam : "";

  return (
    <>
      <BackLink href={copy ? `/manage/tasks/${copy.sourceId}` : "/manage/tasks"}>{copy ? "Back to task" : "Tasks"}</BackLink>
      <PageHeader
        title={copy ? "Duplicate task" : "New task"}
        description={
          copy ? (
            <span className="wrap-anywhere">
              Copy of “{copy.sourceTitle}”, due today. Check the date and people, then create it.
            </span>
          ) : (
            "Assign it to people, or let them sign up on the Task dashboard."
          )
        }
      />
      <TaskForm
        // Remount when switching between a blank form and a copy (the form keeps its own state).
        key={copy?.sourceId ?? "blank"}
        action={createTaskAction}
        mode="create"
        initial={
          copy
            ? {
                title: copy.title,
                description: copy.description,
                subteam: copy.subteam,
                dueDate: copy.dueDate,
                priority: copy.priority,
                assigneeIds: copy.assigneeIds,
                categoryId: copy.categoryId,
                assignMode: copy.assignMode,
                signupLimit: copy.signupLimit,
              }
            : {
                title: "",
                description: "",
                subteam,
                dueDate: today,
                priority: "NORMAL",
                assigneeIds: [],
                categoryId,
                assignMode: "assign",
                signupLimit: null,
              }
        }
        subteamOptions={options.subteams}
        categories={categories}
        groups={groups}
        minDate={addDays(today, -DUE_DATE_MAX_PAST_DAYS)}
        maxDate={addDays(today, DUE_DATE_MAX_FUTURE_DAYS)}
        cancelHref={copy ? `/manage/tasks/${copy.sourceId}` : "/manage/tasks"}
      />
    </>
  );
}
