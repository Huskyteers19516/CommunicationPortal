"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import {
  createTask,
  deleteTask,
  finishTask,
  removeAssignment,
  reopenAssignment,
  reopenTask,
  setSignupOpen,
  updateTask,
} from "@/server/services/tasks";

export async function createTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createTask(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/manage/tasks/${encodeURIComponent(id)}`);
    },
    { formData },
  );
}

export async function updateTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const input = formDataToObject(formData);
      await updateTask(ctx, input);
      revalidatePath("/", "layout");
      redirect(`/manage/tasks/${encodeURIComponent(String(input.taskId))}`);
    },
    { formData },
  );
}

export async function deleteTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    await deleteTask(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    redirect("/manage/tasks");
  });
}

export async function reopenAssignmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { taskFinished } = await reopenAssignment(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    return taskFinished
      ? "Credit taken back — it no longer counts for them. The task stays finished."
      : "Reopened — it's back on their checklist.";
  });
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** "Mark task finished" (fields: taskId, credit = "everyone" | "none"). Used on the manage page and the dashboard page. */
export async function finishTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { credited, closed } = await finishTask(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    const parts = ["Task marked finished."];
    if (credited > 0) parts.push(`${people(credited)} counted as done.`);
    if (closed > 0) parts.push(`${people(closed)} closed without credit.`);
    return parts.join(" ");
  });
}

/** "Reopen task" (fields: taskId). */
export async function reopenTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { restored } = await reopenTask(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    return restored > 0
      ? `Task reopened. ${people(restored)} went back to where they were.`
      : "Task reopened. People can check it off again.";
  });
}

export async function removeAssignmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await removeAssignment(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "Removed from this task." },
  );
}

/** Close or reopen sign-ups (fields: taskId, open = "true" | "false"). */
export async function setSignupOpenAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const input = formDataToObject(formData);
    await setSignupOpen(ctx, input);
    revalidatePath("/", "layout");
    return input.open === "true" ? "Sign-ups are open again." : "Sign-ups are closed.";
  });
}
