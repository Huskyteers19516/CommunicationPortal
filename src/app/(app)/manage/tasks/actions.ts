"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { createTask, deleteTask, removeAssignment, reopenAssignment, setSignupOpen, updateTask } from "@/server/services/tasks";

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
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await reopenAssignment(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "Reopened — it's back on their checklist." },
  );
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
