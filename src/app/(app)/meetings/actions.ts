"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { meetingRecapHref, meetingRecapsHref, type MeetingAudioUploadStateResult } from "@/lib/meeting-recaps";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext, type ServiceContext } from "@/server/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import { readFormFile } from "@/server/files/upload";
import { scheduleMeetingAudioPurge } from "@/server/meetings/purge";
import { createMeetingCategory, deleteMeetingCategory, renameMeetingCategory } from "@/server/services/meeting-categories";
import {
  addMeetingAudioPart,
  createMeetingRecap,
  type CreateMeetingRecapResult,
  deleteMeetingAudio,
  deleteMeetingRecap,
  getMeetingAudioUploadState,
  MEETING_RECAP_CHANGED,
  type MeetingAudioUploadState,
  updateMeetingRecap,
} from "@/server/services/meeting-recaps";

// Meeting recaps actions (also used by the recorder, /meetings/record). Every service re-checks permissions and state
// from the database. Each one also deletes recordings past their 3 days after the response (scheduleMeetingAudioPurge).

/**
 * Saving a new recap also says which one it is, whether its recording was refused (storage full), whether this was
 * the same save again (`duplicate`: its `requestId` had been saved already), and whether that recap kept its own text
 * instead of this save's (`textKept`: it was edited since, or it's another admin's save — the forms open it with
 * `?saved=first`, which says so).
 */
export type MeetingRecapCreateState =
  | (NonNullable<ActionState> & { recapId?: string; audioRefused?: string | null; duplicate?: boolean; textKept?: boolean })
  | null;
/** An uploaded part also says whether the recording is complete now. */
export type MeetingAudioPartState = (NonNullable<ActionState> & { complete?: boolean }) | null;
/** A new category also says its id and name as saved (the recap form selects it). */
export type MeetingCategoryCreateState = (NonNullable<ActionState> & { categoryId?: string; name?: string }) | null;

/** The signed-in person's context; the expired recordings go after the response. */
async function context(): Promise<ServiceContext> {
  const ctx = await getServiceContext();
  scheduleMeetingAudioPurge();
  return ctx;
}

/**
 * Save a new recap (the recorder's review step, and "Write one up"). No redirect: the recorder uploads the recording
 * next (`recapId`), then opens the recap itself. The submitted values aren't echoed back (a transcript can be
 * 300,000 characters); the forms keep them in their own state. `audioRefused`: saved without the recording, and why.
 * With a `requestId` field, saving again returns the same recap (`duplicate`), with this save's text unless it was
 * edited since or is another admin's (`textKept`). Recordings past their 3 days may have been purged to make room:
 * their R2 objects go after the response.
 */
export async function createMeetingRecapAction(_prev: MeetingRecapCreateState, formData: FormData): Promise<MeetingRecapCreateState> {
  let created: CreateMeetingRecapResult | undefined;
  const state = await runAction(
    async () => {
      created = await createMeetingRecap(await context(), formDataToObject(formData));
      scheduleFileCleanup();
      revalidatePath("/", "layout");
      return created.audioRefused ? "Recap saved, without the recording." : "Recap saved.";
    },
    {},
  );
  return state?.ok && created
    ? { ...state, recapId: created.id, audioRefused: created.audioRefused, duplicate: created.duplicate, textKept: created.textKept }
    : state;
}

/**
 * Save the edit form, then open the recap (`?saved=1`, or `?saved=0` when nothing changed). After "Someone else
 * changed this recap…" the page is refreshed so the form can show the newer version (the typed values stay, and are
 * echoed back); the form keeps the version it loaded until the admin picks "Save mine anyway" or "Use their version"
 * (MeetingRecapForm). When the recap was deleted meanwhile, nothing refreshes (a 404 would replace the form).
 */
export async function updateMeetingRecapAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await context();
      let result: { id: string; changed: boolean };
      try {
        result = await updateMeetingRecap(ctx, formDataToObject(formData));
      } catch (e) {
        if (e instanceof ConflictError && e.userMessage === MEETING_RECAP_CHANGED) revalidatePath("/", "layout");
        throw e;
      }
      revalidatePath("/", "layout");
      redirect(`${meetingRecapHref(result.id)}?saved=${result.changed ? "1" : "0"}`);
    },
    { formData },
  );
}

/**
 * Delete a recap with its recording (the R2 objects go after the response), then back to the list, where
 * `?removed=1` says it's gone — also when someone else deleted it first. When it changed since the page showed it
 * (a `version` was sent), the page refreshes so the person can take a look first.
 */
export async function deleteMeetingRecapAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await context();
    try {
      await deleteMeetingRecap(ctx, formDataToObject(formData));
      scheduleFileCleanup();
    } catch (e) {
      if (e instanceof ConflictError) revalidatePath("/", "layout");
      if (!(e instanceof NotFoundError)) throw e;
    }
    revalidatePath("/", "layout");
    redirect(meetingRecapsHref({}, { removed: "1" }));
  });
}

/**
 * Upload one part of a recap's recording (fields: recapId, position, file — at most MEETING_AUDIO_PART_BYTES). The
 * pages refresh only once the recording is complete (`complete`), so a 10-part upload doesn't refresh 10 times; the
 * R2 objects of recordings purged meanwhile to make room (see addMeetingAudioPart) are drained then too.
 */
export async function uploadMeetingAudioPartAction(_prev: MeetingAudioPartState, formData: FormData): Promise<MeetingAudioPartState> {
  let complete = false;
  const state = await runAction(async () => {
    const ctx = await context();
    ({ complete } = await addMeetingAudioPart(ctx, { ...formDataToObject(formData), file: await readFormFile(formData) }));
    if (complete) {
      scheduleFileCleanup();
      revalidatePath("/", "layout");
    }
  });
  return state?.ok ? { ...state, complete } : state;
}

/**
 * Which parts of a recap's recording are in (the recorder finishing an interrupted upload). `gone` only when the recap
 * was deleted; every other failure (signed out, no access anymore, the database) comes with its message, so the
 * recorder keeps its copy and can try again.
 */
export async function getMeetingAudioUploadStateAction(recapId: string): Promise<MeetingAudioUploadStateResult> {
  let state: MeetingAudioUploadState | undefined;
  let gone = false;
  const result = await runAction(async () => {
    try {
      state = await getMeetingAudioUploadState(await context(), { recapId });
    } catch (e) {
      gone = e instanceof NotFoundError;
      throw e;
    }
  });
  if (result?.ok && state) return { ok: true, state };
  if (gone) return { ok: false, gone: true };
  return { ok: false, gone: false, message: result?.message || "Something went wrong. Please try again." };
}

/** "Delete recording now" (fields: recapId): the parts go (their R2 objects after the response); the text stays. */
export async function deleteMeetingAudioAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await context();
    try {
      await deleteMeetingAudio(ctx, formDataToObject(formData));
      scheduleFileCleanup();
    } finally {
      revalidatePath("/", "layout");
    }
    return "Recording deleted. The transcript and key points stay.";
  });
}

/** Add a meeting category (fields: name). Says its id and name, so the recap form can select it. */
export async function createMeetingCategoryAction(_prev: MeetingCategoryCreateState, formData: FormData): Promise<MeetingCategoryCreateState> {
  let created: { id: string; name: string } | undefined;
  const state = await runAction(
    async () => {
      created = await createMeetingCategory(await context(), formDataToObject(formData));
      revalidatePath("/", "layout");
      return `Added “${created.name}”.`;
    },
    { formData },
  );
  return state?.ok && created ? { ...state, categoryId: created.id, name: created.name } : state;
}

/** Rename a meeting category (fields: categoryId, name). */
export async function renameMeetingCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const { changed, name } = await renameMeetingCategory(await context(), formDataToObject(formData));
      revalidatePath("/", "layout");
      return changed ? `Renamed to “${name}”.` : "That's its name already.";
    },
    { formData },
  );
}

/** Delete a meeting category (fields: categoryId). Its recaps stay, without it. */
export async function deleteMeetingCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await context();
    try {
      const { name, recaps } = await deleteMeetingCategory(ctx, formDataToObject(formData));
      return recaps > 0 ? `Deleted “${name}” (taken off ${recaps} ${recaps === 1 ? "recap" : "recaps"}).` : `Deleted “${name}”.`;
    } finally {
      revalidatePath("/", "layout");
    }
  });
}
