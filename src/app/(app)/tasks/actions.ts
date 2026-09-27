"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { leaveTask, signUpForTask } from "@/server/services/signups";

// Task dashboard actions (fields: taskId). The services re-check everything under a row lock.

export async function signUpForTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await signUpForTask(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "You're signed up — it's on your checklist." },
  );
}

export async function leaveTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await leaveTask(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "You left this task." },
  );
}
