"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import {
  createResource,
  deleteResource,
  reviewDoneMessage,
  reviewResource,
  updateResource,
  type UploadedFile,
} from "@/server/services/resources";

/**
 * The picked file, read from the form (formDataToObject only keeps its name). An empty file input
 * arrives as a nameless 0-byte File: that means "no file chosen".
 */
async function uploadFrom(formData: FormData): Promise<UploadedFile | undefined> {
  const file = formData.get("file");
  if (!(file instanceof File) || (file.size === 0 && !file.name)) return undefined;
  return { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
}

async function resourceInput(formData: FormData): Promise<Record<string, unknown>> {
  return { ...formDataToObject(formData), file: await uploadFrom(formData) };
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
