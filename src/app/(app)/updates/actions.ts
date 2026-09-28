"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { meetingFeedHref, meetingUpdateAnchor, parseMeetingFeedFilters } from "@/lib/meeting-updates";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { createMeetingUpdate, deleteMeetingUpdate, updateMeetingUpdate } from "@/server/services/meeting-updates";

// Meeting updates actions. Every service re-checks permissions and state from the database.

/** Post an update, then show it on the feed ("?added=" says it's posted and focuses it). */
export async function createMeetingUpdateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createMeetingUpdate(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`${meetingFeedHref({ mine: false }, { added: id })}#${meetingUpdateAnchor(id)}`);
    },
    { formData },
  );
}

/**
 * Save the edit form. The page is refreshed even when the save fails: after "Someone else changed this
 * update…" the form carries the newest version (the typed text is kept), so saving again replaces it.
 */
export async function updateMeetingUpdateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      let result: { id: string; changed: boolean };
      try {
        result = await updateMeetingUpdate(ctx, formDataToObject(formData));
      } finally {
        revalidatePath("/", "layout");
      }
      const { id, changed } = result;
      redirect(`${meetingFeedHref({ mine: false }, { [changed ? "saved" : "unchanged"]: id })}#${meetingUpdateAnchor(id)}`);
    },
    { formData },
  );
}

/**
 * Remove an update (from the feed or its edit page), then back to the feed — with the filters and page the
 * feed had (`back`, re-validated here) — where "?removed=" and "&date=" say which update is gone.
 */
export async function deleteMeetingUpdateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { subteam, meetingDate } = await deleteMeetingUpdate(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    const back = formData.get("back");
    const params = new URLSearchParams(typeof back === "string" && back.length <= 200 ? back : "");
    const filters = parseMeetingFeedFilters((key) => params.get(key) ?? undefined);
    redirect(meetingFeedHref(filters, { removed: subteam, date: meetingDate }));
  });
}
