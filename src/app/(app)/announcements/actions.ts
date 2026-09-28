"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { type AnnouncementFormValues, announcementAnchor, announcementsHref, parseAnnouncementFilters } from "@/lib/announcements";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { getAnnouncementFormValues } from "@/server/queries/announcements";
import {
  createAnnouncement,
  deleteAnnouncement,
  markAnnouncementsSeen,
  setAnnouncementPinned,
  updateAnnouncement,
} from "@/server/services/announcements";

// Announcements actions. Every service re-checks permissions and state from the database.

/** The edit form's state: after "someone else changed it", also the newest values (`latest`). */
export type AnnouncementFormState = (NonNullable<ActionState> & { latest?: AnnouncementFormValues }) | null;

const CHANGED_MEANWHILE =
  "Someone else changed this announcement while you were editing. The form now shows their version, with your own edits kept. Check it, then save again.";

/** The list, opened on the page that has this announcement, with what to say about it ("?posted=" etc.). */
function listAt(param: "posted" | "saved" | "unchanged", id: string): string {
  return `${announcementsHref({}, { [param]: id })}#${announcementAnchor(id)}`;
}

/** Post an announcement, then show it on the list (focused, "Posted."). */
export async function createAnnouncementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createAnnouncement(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(listAt("posted", id));
    },
    { formData },
  );
}

/**
 * Save the edit form. After "someone else changed this announcement…" the form gets the newest values and version
 * (`latest`; it keeps the person's own edits on top), and the page refreshes. When it was removed meanwhile, nothing
 * refreshes: the form stays, with what they typed and why it can't be saved (a refresh would show a 404 instead).
 */
export async function updateAnnouncementAction(_prev: AnnouncementFormState, formData: FormData): Promise<AnnouncementFormState> {
  let latest: AnnouncementFormValues | null | undefined;
  const state = await runAction(
    async () => {
      const ctx = await getServiceContext();
      let result: { id: string; changed: boolean };
      try {
        result = await updateAnnouncement(ctx, formDataToObject(formData));
      } catch (e) {
        if (e instanceof ConflictError) {
          const id = formData.get("announcementId");
          latest = typeof id === "string" ? await getAnnouncementFormValues(ctx.actor, id) : null;
          revalidatePath("/", "layout");
        }
        throw e;
      }
      revalidatePath("/", "layout");
      redirect(listAt(result.changed ? "saved" : "unchanged", result.id));
    },
    { formData },
  );
  return state && !state.ok && latest ? { ...state, message: CHANGED_MEANWHILE, latest } : state;
}

/**
 * Remove an announcement (from the list or its edit page), then back to the list with the filter and page it had
 * (`back`, re-checked here), where "?removed=1" says it's gone — also when someone else removed it first. When it
 * changed since the page showed it, the page refreshes so the person can take a look first.
 */
export async function deleteAnnouncementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    try {
      await deleteAnnouncement(ctx, formDataToObject(formData));
    } catch (e) {
      if (e instanceof ConflictError) revalidatePath("/", "layout");
      if (!(e instanceof NotFoundError)) throw e;
    }
    revalidatePath("/", "layout");
    const back = formData.get("back");
    const params = new URLSearchParams(typeof back === "string" && back.length <= 200 ? back : "");
    redirect(announcementsHref(parseAnnouncementFilters((key) => params.get(key) ?? undefined), { removed: "1" }));
  });
}

/** Pin to the top / unpin. The message goes to the button's status line. */
export async function setAnnouncementPinnedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    // A refusal (e.g. it was removed meanwhile) leaves the card where it is, with the reason under the button.
    const { pinned } = await setAnnouncementPinned(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    // Short: it's shown under the button.
    return pinned ? "Pinned." : "Unpinned.";
  });
}

/**
 * Called by the list once it's on screen (never while rendering, so opening or prefetching a link writes nothing):
 * everything posted up to when the page loaded is seen. Returns how many unread announcements that cleared (0 when
 * it failed); the list then refreshes itself, so the menu badge updates. It doesn't revalidate here: an action's
 * refresh re-applies the address's #announcement-… hash, and the next page (e.g. Today) then didn't open at the top.
 */
export async function markAnnouncementsSeenAction(upTo: unknown): Promise<number> {
  let cleared = 0;
  await runAction(async () => {
    const ctx = await getServiceContext();
    ({ cleared } = await markAnnouncementsSeen(ctx, { upTo }));
  });
  return cleared;
}
