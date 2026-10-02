import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/tasks/back-link";
import { TaskForm } from "@/components/tasks/task-form";
import { PageHeader } from "@/components/ui/page-header";
import { addDays, todayInTimezone } from "@/lib/dates";
import { requireStaffUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { hasAllScope } from "@/server/permissions";
import { getTaskFormCategories } from "@/server/queries/categories";
import { type AssignablePerson, getAssignableUsers, getManagedTaskDetail, getTaskFormOptions, groupPeople } from "@/server/queries/tasks";
import { DUE_DATE_MAX_FUTURE_DAYS, DUE_DATE_MAX_PAST_DAYS } from "@/server/services/tasks";
import { updateTaskAction } from "../../actions";

export const metadata: Metadata = { title: "Edit task" };

export default async function EditTaskPage({ params }: PageProps<"/manage/tasks/[id]/edit">) {
  const actor = await requireStaffUser();
  const { id } = await params;
  const [task, assignable, categories] = await Promise.all([
    getManagedTaskDetail(actor, id),
    getAssignableUsers(actor),
    getTaskFormCategories(actor),
  ]);
  if (!task) notFound();

  // People already on the task stay visible (and checked) even if the actor couldn't add them today,
  // so saving never drops them by accident.
  // A subteam leader can't take themselves off a task (the service enforces it; this explains why).
  const lockSelf = !hasAllScope(actor) && task.assignments.some((a) => a.user.id === actor.id);
  const people: AssignablePerson[] = assignable
    .flatMap((g) => g.people)
    .map((p) =>
      lockSelf && p.id === actor.id
        ? { ...p, locked: true, note: "That's you — ask another leader or the captain to remove you" }
        : p,
    );
  const known = new Set(people.map((p) => p.id));
  for (const a of task.assignments) {
    if (known.has(a.user.id)) continue;
    people.push({
      id: a.user.id,
      name: a.user.name,
      role: a.user.role,
      subteam: a.user.subteam,
      note: a.user.status === "ACTIVE" ? "Outside your subteam — can't be re-added" : "Not active — can't be re-added",
    });
  }

  const options = getTaskFormOptions(actor, { createdById: task.createdBy.id });
  const today = todayInTimezone(env.teamTimezone);
  const minDate = addDays(today, -DUE_DATE_MAX_PAST_DAYS);

  return (
    <>
      <BackLink href={`/manage/tasks/${task.id}`}>Back to task</BackLink>
      <PageHeader title="Edit task" description={<span className="wrap-anywhere">{task.title}</span>} />
      <TaskForm
        action={updateTaskAction}
        mode="edit"
        taskId={task.id}
        initial={{
          title: task.title,
          description: task.description,
          subteam: task.subteam ?? "",
          dueDate: task.dueDate,
          priority: task.priority,
          assigneeIds: task.assignments.map((a) => a.user.id),
          categoryId: task.category?.id ?? "",
          assignMode: task.assignMode,
          signupLimit: task.signupLimit,
        }}
        signupClosed={task.assignMode === "signup" && !task.signupOpen}
        finished={task.completedAt !== null}
        subteamOptions={options.subteams}
        newCategorySubteams={options.newCategorySubteams}
        categories={categories}
        groups={groupPeople(people)}
        minDate={task.dueDate < minDate ? task.dueDate : minDate}
        maxDate={addDays(today, DUE_DATE_MAX_FUTURE_DAYS)}
        cancelHref={`/manage/tasks/${task.id}`}
      />
    </>
  );
}
