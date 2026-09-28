"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { discussionHref } from "@/lib/discussion";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { ConflictError } from "@/server/errors";
import {
  createReply,
  createThread,
  DISCUSSION_CHANGED,
  deleteReply,
  deleteThread,
  markThreadRead,
  setThreadLocked,
  setThreadPinned,
  updateReply,
  updateThread,
} from "@/server/services/discussion";

// Discussion actions. Every service re-checks permissions and state from the database.

/** Start a discussion, then open it ("?started=1" says it's up). */
export async function createThreadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createThread(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`${discussionHref(id)}?started=1`);
    },
    { formData },
  );
}

/**
 * Save the edit form. After "You changed this discussion somewhere else…" the page is refreshed too, so the form
 * carries the newest `version` and saving again replaces it (the typed text stays). Other failures don't refresh:
 * when the discussion is gone or was just locked, a refresh would swap the form (and the typed text) for a 404 or
 * the discussion's page, instead of saying what happened.
 */
export async function updateThreadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      let result: { id: string; changed: boolean };
      try {
        result = await updateThread(ctx, formDataToObject(formData));
      } catch (e) {
        if (e instanceof ConflictError && e.userMessage === DISCUSSION_CHANGED) revalidatePath("/", "layout");
        throw e;
      }
      revalidatePath("/", "layout");
      redirect(`${discussionHref(result.id)}?saved=${result.changed ? "1" : "0"}`);
    },
    { formData },
  );
}

/** Delete a discussion (and its replies), then back to the list ("?removed=1" says it's gone). */
export async function deleteThreadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await deleteThread(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect("/discussion?removed=1");
    },
    { formData },
  );
}

/** Pin to the top or unpin (people with admin access). The message goes to the button's status line. */
export async function setThreadPinnedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { pinned } = await setThreadPinned(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    return pinned ? "Pinned." : "Unpinned.";
  });
}

/** Lock or unlock (people with admin access). */
export async function setThreadLockedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { locked } = await setThreadLocked(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    return locked ? "Locked." : "Unlocked.";
  });
}

/**
 * Remember that I've read a discussion, up to the last activity its page showed. Called by the page once it's
 * open (and visible) in the browser, never while it loads, so prefetching a link can't mark anything read. Only
 * when the mark moved is the page refreshed (that updates the nav badge; the page keeps its "New" divider while
 * it's open): opening a discussion that was already read costs no second render.
 */
export async function markThreadReadAction(threadId: string, seen: string): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { moved } = await markThreadRead(ctx, { threadId, seen });
    if (moved) revalidatePath("/", "layout");
  });
}

/** Post a reply, then show it: `?posted=<id>` focuses it and says so, `#reply-<id>` scrolls to it. */
export async function createReplyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id, threadId } = await createReply(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`${discussionHref(threadId)}?posted=${encodeURIComponent(id)}#reply-${encodeURIComponent(id)}`);
    },
    { formData },
  );
}

/**
 * Save a reply's new text (inline). Refreshed after a save and after a conflict (changed in another tab: saving
 * again then replaces it; or just locked: the page shows it). Not when the reply (or its discussion) is gone: the
 * refresh would take the reply off the page with its edit box, the message, and the typed text, and drop focus.
 * Without it, the box stays with "That reply no longer exists." under it, so the text can still be copied.
 */
export async function updateReplyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      try {
        const { changed } = await updateReply(ctx, formDataToObject(formData));
        revalidatePath("/", "layout");
        return changed ? "Reply updated." : "Nothing changed.";
      } catch (e) {
        if (e instanceof ConflictError) revalidatePath("/", "layout");
        throw e;
      }
    },
    { formData },
  );
}

/** Delete a reply, then back to the replies ("?deleted=1" says it's gone). */
export async function deleteReplyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { threadId } = await deleteReply(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`${discussionHref(threadId)}?deleted=1#replies`);
    },
    { formData },
  );
}
