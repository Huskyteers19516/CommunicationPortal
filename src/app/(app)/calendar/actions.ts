"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { monthOf, parseCalendarReturn } from "@/lib/calendar";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from "@/server/services/calendar";

// Team calendar actions. Every service re-checks permissions and state from the database.

export async function createCalendarEventAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createCalendarEvent(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      // Opened from Attendance ("Add an extra meeting"): the new event's page leads back there.
      const from = parseCalendarReturn(formData.get("from"));
      redirect(`/calendar/${encodeURIComponent(id)}?added=1${from ? `&from=${from}` : ""}`);
    },
    { formData },
  );
}

/**
 * The page is refreshed even when the save fails: after "Someone changed this event…" the form then carries the
 * newest `version`, so saving again replaces the other change (the typed values are kept).
 */
export async function updateCalendarEventAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      let id: string;
      try {
        ({ id } = await updateCalendarEvent(ctx, formDataToObject(formData)));
      } finally {
        revalidatePath("/", "layout");
      }
      redirect(`/calendar/${encodeURIComponent(id)}?saved=1`);
    },
    { formData },
  );
}

/** Remove an event, then say so on the calendar, showing the month it was in. */
export async function deleteCalendarEventAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { title, startsOn } = await deleteCalendarEvent(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/calendar?month=${monthOf(startsOn)}&removed=${encodeURIComponent(title)}`);
    },
    { formData },
  );
}
