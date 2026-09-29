"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import { getServiceContext } from "@/server/context";
import {
  createLeagueTeam,
  deleteLeagueTeam,
  saveLeagueTeamSummary,
  updateLeagueTeam,
} from "@/server/services/league-teams";

/** Add a team to Other teams (people with admin access), then open its page. */
export async function createLeagueTeamAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { number } = await createLeagueTeam(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/strategy/teams/${number}?added=1`);
    },
    { formData },
  );
}

export async function updateLeagueTeamAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { number } = await updateLeagueTeam(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/strategy/teams/${number}?saved=1`);
    },
    { formData },
  );
}

/**
 * Remove a team (and the strategies about it), then back to the list, which says what went
 * ("?removed=9040 · STEAMpunks Alpha&strategies=3").
 */
export async function deleteLeagueTeamAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { number, name, strategies } = await deleteLeagueTeam(ctx, formDataToObject(formData));
      scheduleFileCleanup(); // the strategies about them, and their files, went with them
      revalidatePath("/", "layout");
      const sp = new URLSearchParams({ removed: `${number} · ${name}` });
      if (strategies > 0) sp.set("strategies", String(strategies));
      redirect(`/strategy/teams?${sp.toString()}`);
    },
    { formData },
  );
}

/**
 * Save "Their strategy at a glance". The page is refreshed either way, so after a conflict it shows the newer
 * version (and its version, so saving again replaces it) next to the text that was sent back.
 */
export async function saveLeagueTeamSummaryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      try {
        const ctx = await getServiceContext();
        await saveLeagueTeamSummary(ctx, formDataToObject(formData));
      } finally {
        revalidatePath("/", "layout");
      }
    },
    { success: "Saved.", formData },
  );
}
