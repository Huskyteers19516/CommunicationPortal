"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { readFormFile } from "@/server/files/upload";
import { createPoster, deletePoster, updatePoster } from "@/server/services/posters";

/** The form's fields plus the picked file (formDataToObject only keeps its name). */
async function posterInput(formData: FormData): Promise<Record<string, unknown>> {
  return { ...formDataToObject(formData), file: await readFormFile(formData) };
}

/** Add a poster, then open it ("?added=1" shows a confirmation). */
export async function createPosterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createPoster(ctx, await posterInput(formData));
      revalidatePath("/", "layout");
      redirect(`/posters/${encodeURIComponent(id)}?added=1`);
    },
    { formData },
  );
}

export async function updatePosterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await updatePoster(ctx, await posterInput(formData));
      revalidatePath("/", "layout");
      redirect(`/posters/${encodeURIComponent(id)}?saved=1`);
    },
    { formData },
  );
}

/** Remove a poster, then back to the grid ("?removed=1" says it's gone). */
export async function deletePosterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await deletePoster(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect("/posters?removed=1");
    },
    { formData },
  );
}
