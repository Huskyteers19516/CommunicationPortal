"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { ConflictError } from "@/server/errors";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import { readFormFile } from "@/server/files/upload";
import {
  addWorkshopFile,
  addWorkshopPhoto,
  createWorkshopProject,
  deleteWorkshopProject,
  moveWorkshopPhoto,
  removeWorkshopFile,
  removeWorkshopPhoto,
  reviewWorkshopProject,
  setWorkshopCover,
  setWorkshopFeatured,
  submitWorkshopProject,
  unpublishWorkshopProject,
  updateWorkshopPhoto,
  updateWorkshopProject,
  WORKSHOP_CHANGED,
} from "@/server/services/workshop";

/** The project's page, with a confirmation flag ("?added=1"). */
function projectHref(id: string, flag?: string): string {
  return `/workshop/${encodeURIComponent(id)}${flag ? `?${flag}=1` : ""}`;
}

/** The form's fields plus the picked file (formDataToObject only keeps its name). */
async function withFile(formData: FormData): Promise<Record<string, unknown>> {
  return { ...formDataToObject(formData), file: await readFormFile(formData) };
}

const BACK_FOR_APPROVAL = "It's off the team website until a leader approves it again.";

/**
 * A reviewer's decision (Approve, Send back, Publish), refused because the project changed since their page showed it
 * (WORKSHOP_CHANGED): the page is refreshed too, so the refusal shows by the button they pressed with the new photos,
 * files, and words around it (and the next try carries the new version).
 */
async function refreshIfChanged<T>(decision: Promise<T>): Promise<T> {
  try {
    return await decision;
  } catch (e) {
    if (e instanceof ConflictError && e.userMessage === WORKSHOP_CHANGED) revalidatePath("/", "layout");
    throw e;
  }
}

// ---------- projects ----------

/** Add a project (a draft), then open it ("?added=1" says what to do next). */
export async function createWorkshopProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createWorkshopProject(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(projectHref(id, "added"));
    },
    { formData },
  );
}

/**
 * Save details and credits ("?resubmitted=1" when the change took it off the website until it's approved again).
 * Someone who took their own name off a project they can't see any more goes back to the list ("?left=1").
 */
export async function updateWorkshopProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id, sentForApproval, stillVisible } = await updateWorkshopProject(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      if (!stillVisible) redirect("/workshop?left=1");
      redirect(projectHref(id, sentForApproval ? "resubmitted" : "saved"));
    },
    { formData },
  );
}

/** Remove a project with its photos and files, then back to the list ("?removed=1"). */
export async function deleteWorkshopProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await deleteWorkshopProject(ctx, formDataToObject(formData));
      scheduleFileCleanup();
      revalidatePath("/", "layout");
      redirect("/workshop?removed=1");
    },
    { formData },
  );
}

/**
 * Send for approval ("?sent=1"), or, for reviewers, publish straight to the website ("?published=1"; `version` = the
 * project as they saw it, refusing it if it changed since).
 */
export async function submitWorkshopProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const input = formDataToObject(formData);
      const { status } = await refreshIfChanged(submitWorkshopProject(ctx, input));
      revalidatePath("/", "layout");
      redirect(projectHref(String(input.projectId), status === "APPROVED" ? "published" : "sent"));
    },
    { formData },
  );
}

/** Reviewers: approve ("?approved=1") or send back with a note ("?returned=1"), for the `version` they saw. */
export async function reviewWorkshopProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const input = formDataToObject(formData);
      const { status } = await refreshIfChanged(reviewWorkshopProject(ctx, input));
      revalidatePath("/", "layout");
      redirect(projectHref(String(input.projectId), status === "APPROVED" ? "approved" : "returned"));
    },
    { formData },
  );
}

/**
 * Take a project off the website, or withdraw it from waiting for approval (both → draft). `was` ("pending" /
 * "approved") only picks the confirmation.
 */
export async function unpublishWorkshopProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await unpublishWorkshopProject(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(projectHref(id, formData.get("was") === "pending" ? "withdrawn" : "unpublished"));
    },
    { formData },
  );
}

/** Reviewers: show a project first on the website (a switch: `featured` = "on" or missing). */
export async function setWorkshopFeaturedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { featured } = await setWorkshopFeatured(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    return featured ? "Featured: it's shown first in its section." : "Not featured any more.";
  });
}

// ---------- photos ----------

/** Add a photo at the end of the story. Stays on the project page; the form says when it went back for approval. */
export async function addWorkshopPhotoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { sentForApproval } = await addWorkshopPhoto(ctx, await withFile(formData));
      revalidatePath("/", "layout");
      return sentForApproval ? `Photo added. ${BACK_FOR_APPROVAL}` : "Photo added.";
    },
    { formData },
  );
}

/** Change a photo's label and note. */
export async function updateWorkshopPhotoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { sentForApproval } = await updateWorkshopPhoto(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      return sentForApproval ? `Caption saved. ${BACK_FOR_APPROVAL}` : "Caption saved.";
    },
    { formData },
  );
}

/** Move a photo one place earlier ("up") or later ("down"). */
export async function moveWorkshopPhotoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    await moveWorkshopPhoto(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
  });
}

/** Make a photo the cover. */
export async function setWorkshopCoverAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    await setWorkshopCover(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
  });
}

/** Remove a photo (and its stored file). */
export async function removeWorkshopPhotoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    await removeWorkshopPhoto(ctx, formDataToObject(formData));
    scheduleFileCleanup();
    revalidatePath("/", "layout");
  });
}

// ---------- design files ----------

/** Add a design file. Stays on the project page; the form says when it went back for approval. */
export async function addWorkshopFileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { sentForApproval } = await addWorkshopFile(ctx, await withFile(formData));
      revalidatePath("/", "layout");
      return sentForApproval ? `File added. ${BACK_FOR_APPROVAL}` : "File added.";
    },
    { formData },
  );
}

/** Remove a design file. */
export async function removeWorkshopFileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    await removeWorkshopFile(ctx, formDataToObject(formData));
    scheduleFileCleanup();
    revalidatePath("/", "layout");
  });
}
