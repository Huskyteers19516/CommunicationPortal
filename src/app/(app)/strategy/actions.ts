"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import type { UploadedFile } from "@/server/files/upload";
import { createStrategy, deleteStrategy, setStrategyPinned, updateStrategy } from "@/server/services/strategy";

/** Every file picked in the form's `files` input (formDataToObject only keeps their names). */
async function readFormFiles(formData: FormData): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  for (const value of formData.getAll("files")) {
    // An empty file input arrives as a nameless 0-byte File: "no file chosen".
    if (!(value instanceof File) || (value.size === 0 && !value.name)) continue;
    files.push({ name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) });
  }
  return files;
}

/** The form's fields plus the picked files. */
async function strategyInput(formData: FormData): Promise<Record<string, unknown>> {
  return { ...formDataToObject(formData), files: await readFormFiles(formData) };
}

/** Add a strategy, then open it ("?added=1" shows a confirmation). */
export async function createStrategyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createStrategy(ctx, await strategyInput(formData));
      revalidatePath("/", "layout");
      redirect(`/strategy/${encodeURIComponent(id)}?added=1`);
    },
    { formData },
  );
}

export async function updateStrategyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await updateStrategy(ctx, await strategyInput(formData));
      scheduleFileCleanup(); // removed files
      revalidatePath("/", "layout");
      redirect(`/strategy/${encodeURIComponent(id)}?saved=1`);
    },
    { formData },
  );
}

/**
 * Remove a strategy (and its files), then back to the list it was on — ours, or the other team's page
 * ("?removed=1" says it's gone).
 */
export async function deleteStrategyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { teamNumber } = await deleteStrategy(ctx, formDataToObject(formData));
      scheduleFileCleanup(); // its files went with it
      revalidatePath("/", "layout");
      redirect(teamNumber === null ? "/strategy?removed=1" : `/strategy/teams/${teamNumber}?removed=1`);
    },
    { formData },
  );
}

/** Pin or unpin (people with admin access). The message goes to the button's status line. */
export async function setStrategyPinnedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { pinned } = await setStrategyPinned(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    // Short: it's shown under the button, as wide as the button.
    return pinned ? "Pinned." : "Unpinned.";
  });
}
