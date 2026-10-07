"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import { readFormFile } from "@/server/files/upload";
import {
  resetSiteContent,
  revertSiteContentEdit,
  setSiteImageAlt,
  setSiteLink,
  setSiteText,
  uploadSiteImage,
} from "@/server/services/site-content";

const LIVE_SOON = "The public site shows this within about a minute.";
const UNCHANGED = "Nothing to save — that's what it says already.";

/** Save a text spot. */
export async function setSiteTextAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const { changed } = await setSiteText(await getServiceContext(), formDataToObject(formData));
      revalidatePath("/", "layout");
      return changed ? `Saved. ${LIVE_SOON}` : UNCHANGED;
    },
    { formData },
  );
}

/** Save a link spot. */
export async function setSiteLinkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const { changed } = await setSiteLink(await getServiceContext(), formDataToObject(formData));
      revalidatePath("/", "layout");
      return changed ? `Saved. ${LIVE_SOON}` : UNCHANGED;
    },
    { formData },
  );
}

/** Upload a picture for a picture spot (older pictures past the few kept are deleted). */
export async function uploadSiteImageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { pruned } = await uploadSiteImage(ctx, { ...formDataToObject(formData), file: await readFormFile(formData) });
      if (pruned > 0) scheduleFileCleanup(); // the deleted pictures' files
      revalidatePath("/", "layout");
      return `Picture uploaded. ${LIVE_SOON}`;
    },
    { formData },
  );
}

/** Change the description (alt text) of the picture a spot shows. */
export async function setSiteImageAltAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const { changed } = await setSiteImageAlt(await getServiceContext(), formDataToObject(formData));
      revalidatePath("/", "layout");
      return changed ? `Description saved. ${LIVE_SOON}` : UNCHANGED;
    },
    { formData },
  );
}

/** "Reset to original": the website shows its own content for this spot again. */
export async function resetSiteContentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const { changed } = await resetSiteContent(await getServiceContext(), formDataToObject(formData));
      revalidatePath("/", "layout");
      return changed ? `Back to the website's original. ${LIVE_SOON}` : "This spot already shows the website's original.";
    },
    { formData },
  );
}

/** Undo one change from "Recent changes". */
export async function revertSiteContentEditAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const { changed } = await revertSiteContentEdit(await getServiceContext(), formDataToObject(formData));
      revalidatePath("/", "layout");
      return changed ? `Undone. ${LIVE_SOON}` : "Nothing to undo — it already shows that.";
    },
    { formData },
  );
}
