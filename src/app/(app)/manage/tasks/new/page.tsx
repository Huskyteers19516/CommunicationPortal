import type { Metadata } from "next";
import { BackLink } from "@/components/tasks/back-link";
import { TaskForm } from "@/components/tasks/task-form";
import { PageHeader } from "@/components/ui/page-header";
import type { Subteam } from "@/generated/prisma/enums";
import { SUBTEAMS } from "@/lib/constants";
import { addDays, todayInTimezone } from "@/lib/dates";
import { parsePeopleParam, prefillAssigneeIds, prefillBackHref, prefillDueDate, prefillSubteam } from "@/lib/task-prefill";
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

  // ?people=<id>,<id> (Attendance → "Assign a task to the people coming"): only people the actor can assign.
  const people = copy ? [] : prefillAssigneeIds(parsePeopleParam(sp.people), groups);
  // ?subteam=BUILD|TEAM&category=<id> (the dashboard's "+" buttons): only subteams and categories the actor may use.
  const subteamParam = first(sp.subteam);
  const wanted: "" | Subteam | undefined = subteamParam === "TEAM" ? "" : SUBTEAMS.find((s) => s === subteamParam);
  // The Business leader's people from other subteams only fit a whole-team task, so that's where a prefill starts.
  const subteam = prefillSubteam({
    requested: wanted,
    allowed: options.subteams.map((o) => o.value),
    defaultSubteam: options.defaultSubteam,
    people,
    groups,
  });
  const categoryParam = first(sp.category);
  const categoryId = categoryParam && categories[subteam]?.some((c) => c.id === categoryParam) ? categoryParam : "";
  // ?due=<day> and ?back=/attendance/plan?day=<day> (same link): the planned day, and back to "Who's coming".
  const minDate = addDays(today, -DUE_DATE_MAX_PAST_DAYS);
  const maxDate = addDays(today, DUE_DATE_MAX_FUTURE_DAYS);
  const dueDate = (!copy && prefillDueDate(sp.due, minDate, maxDate)) || today;
  const back = copy ? null : prefillBackHref(sp.back);

  return (
    <>
      <BackLink href={copy ? `/manage/tasks/${copy.sourceId}` : (back ?? "/manage/tasks")}>
        {copy ? "Back to task" : back ? "Who's coming" : "Tasks"}
      </BackLink>
      <PageHeader
        title={copy ? "Duplicate task" : "New task"}
        description={
          copy ? (
            <span className="wrap-anywhere">
              Copy of “{copy.sourceTitle}”, due today. Check the date and people, then create it.
            </span>
          ) : people.length > 0 ? (
            `${people.length} ${people.length === 1 ? "person is" : "people are"} picked below. Check them, then create it.`
          ) : (
            "Assign it to people, or let them sign up on the Task dashboard."
          )
        }
      />
      <TaskForm
        // Remount when switching between a blank form and a copy (the form keeps its own state).
        key={copy?.sourceId ?? (people.length > 0 ? `people-${dueDate}-${people.join(",")}` : `blank-${dueDate}`)}
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
                dueDate,
                priority: "NORMAL",
                assigneeIds: people,
                categoryId,
                assignMode: "assign",
                signupLimit: null,
              }
        }
        subteamOptions={options.subteams}
        newCategorySubteams={options.newCategorySubteams}
        categories={categories}
        groups={groups}
        minDate={minDate}
        maxDate={maxDate}
        cancelHref={copy ? `/manage/tasks/${copy.sourceId}` : (back ?? "/manage/tasks")}
      />
    </>
  );
}
