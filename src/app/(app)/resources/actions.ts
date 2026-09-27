"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { readFormFile } from "@/server/files/upload";
import { createResource, deleteResource, reviewDoneMessage, reviewResource, updateResource } from "@/server/services/resources";

/** The form's fields plus the picked file (formDataToObject only keeps its name). */
async function resourceInput(formData: FormData): Promise<Record<string, unknown>> {
  return { ...formDataToObject(formData), file: await readFormFile(formData) };
}

export async function createResourceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await createResource(ctx, await resourceInput(formData));
      revalidatePath("/", "layout");
      redirect("/resources");
    },
    { formData },
  );
}

export async function updateResourceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await updateResource(ctx, await resourceInput(formData));
      revalidatePath("/", "layout");
      redirect(`/resources/${encodeURIComponent(id)}`);
    },
    { formData },
  );
}

export async function deleteResourceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await deleteResource(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect("/resources");
    },
    { formData },
  );
}

/**
 * Approve / send back a member's resource (Resources page and the resource's own page). The success
 * message names it ("Approved “X” — …"), since the card it came from disappears.
 */
export async function reviewResourceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const reviewed = await reviewResource(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      return reviewDoneMessage(reviewed);
    },
    { formData },
  );
}
