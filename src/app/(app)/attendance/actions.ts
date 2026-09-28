"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ATTENDANCE_KIND_LABELS, RSVP_LABELS } from "@/lib/attendance";
import type { ActionState } from "@/lib/action-state";
import { todayInTimezone } from "@/lib/dates";
import { formDataToObject, runAction } from "@/server/action";
import { getCurrentUser } from "@/server/auth/session";
import { getServiceContext, type ServiceContext } from "@/server/context";
import { env } from "@/server/env";
import { getLiveCode, type LiveCode } from "@/server/queries/attendance";
import {
  ALREADY_CHECKED_IN,
  addPerson,
  type CheckInResult,
  checkInWithCode,
  checkInWithToken,
  closeSession,
  deleteSession,
  openSession,
  removePerson,
  setDayPlan,
  setRsvp,
  setSessionNote,
  updateSettings,
} from "@/server/services/attendance";

// Attendance actions. Every service re-checks permissions and state from the database.

function checkedInMessage(result: CheckInResult): string {
  if (result.already) return `${ALREADY_CHECKED_IN.replace(/\.$/, "")} ✓`;
  return `You're checked in for ${ATTENDANCE_KIND_LABELS[result.kind]} ✓`;
}

/**
 * Inline buttons and boxes (the page stays put). The page is refreshed even when the action fails, so a
 * stale page catches up. `echo` sends typed values back on failure (boxes with an input).
 */
async function inline<T>(
  formData: FormData,
  service: (ctx: ServiceContext, raw: unknown) => Promise<T>,
  success: (result: T) => string,
  echo = false,
) {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      try {
        return success(await service(ctx, formDataToObject(formData)));
      } finally {
        revalidatePath("/", "layout");
      }
    },
    { formData: echo ? formData : undefined },
  );
}

/** "Start attendance" (or reopen / show today's): goes to the session's live screen. */
export async function startAttendanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { id } = await openSession(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    redirect(`/attendance/sessions/${encodeURIComponent(id)}`);
  });
}

export async function closeSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, closeSession, ({ kind }) => `${ATTENDANCE_KIND_LABELS[kind]} attendance is closed.`);
}

/** Reopen today's closed session from its live screen (the page stays put; old codes stop working). */
export async function reopenSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, openSession, () => {
    const kind = formData.get("kind") === "FLEX" ? "FLEX" : "REGULAR";
    return `${ATTENDANCE_KIND_LABELS[kind]} attendance is open again. Old codes stopped working.`;
  });
}

/** Delete a session started by mistake, then go back to Attendance (which says so). */
export async function deleteSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { kind, date } = await deleteSession(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    redirect(`/attendance?deleted=${kind}-${date}`);
  });
}

export async function addPersonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, addPerson, ({ name }) => `Added ${name}.`);
}

export async function removePersonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, removePerson, ({ name }) => `Took ${name} off the list.`);
}

export async function setSessionNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, setSessionNote, () => "Saved “What we did”.", true);
}

export async function checkInWithCodeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, checkInWithCode, checkedInMessage);
}

/** The scan page calls this once, right after it opens (never on GET, so prefetching can't check anyone in). */
export async function checkInWithTokenAction(token: string): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    try {
      return checkedInMessage(await checkInWithToken(ctx, { token }));
    } finally {
      revalidatePath("/", "layout");
    }
  });
}

export async function setRsvpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const sent = formDataToObject(formData);
  return inline(
    formData,
    setRsvp,
    (r) => {
      if (typeof sent.regular === "string") return r.regular ? `Saved: ${RSVP_LABELS[r.regular]}.` : "Answer cleared.";
      if (typeof sent.flex === "string") return r.flex ? `Saved: Flex ${RSVP_LABELS[r.flex]}.` : "Flex answer cleared.";
      return r.note ? "Note saved." : "Note removed.";
    },
    true,
  );
}

export async function setDayPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, setDayPlan, ({ plan }) => (plan ? "Plan saved. Everyone sees it when they answer." : "Plan removed."), true);
}

export async function updateSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, updateSettings, () => "Schedule saved.", true);
}

/**
 * The projector screen's current QR code (SVG) and 6-digit code, fetched every ~20 seconds. Returns plain data
 * (no secret): only runners get a code, and only for an open session of today.
 */
export async function getLiveCodeAction(sessionId: string): Promise<LiveCode> {
  const actor = await getCurrentUser();
  if (!actor || actor.status !== "ACTIVE") return { ok: false, message: "Please sign in again." };
  if (typeof sessionId !== "string" || sessionId.length > 64) return { ok: false, message: "That attendance session no longer exists.", closed: true };
  const now = new Date();
  return getLiveCode(actor, sessionId, { now, today: todayInTimezone(env.teamTimezone, now), appUrl: env.appUrl });
}
