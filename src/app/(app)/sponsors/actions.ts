"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { SPONSORSHIP_STAGE_LABELS } from "@/lib/constants";
import { formatShortDate } from "@/lib/sponsorships";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import {
  createSponsorship,
  deleteSponsorship,
  importSponsorships,
  setSponsorshipStage,
  updateSponsorship,
  updateSponsorshipInfo,
} from "@/server/services/sponsorships";

/** Add a sponsor, then show it in the list ("?added=<id>": highlighted, with a note if the name was already there). */
export async function createSponsorshipAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id, sameName } = await createSponsorship(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/sponsors?added=${encodeURIComponent(id)}${sameName > 0 ? "&same=1" : ""}`);
    },
    { formData },
  );
}

/** Save the edit form, then show the sponsor in the list ("?saved=<id>"), like adding one. */
export async function updateSponsorshipAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await updateSponsorship(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/sponsors?saved=${encodeURIComponent(id)}`);
    },
    { formData },
  );
}

/** Remove a sponsor, then say so on the list ("?removed=<name>"). */
export async function deleteSponsorshipAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { name } = await deleteSponsorship(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/sponsors?removed=${encodeURIComponent(name)}`);
    },
    { formData },
  );
}

/** The stage menu on the list. Says when it filled in a date ("Saved. Submitted Sep 26."). */
export async function setSponsorshipStageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const change = await setSponsorshipStage(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      if (!change.filled) return "Saved.";
      const label = change.filled.field === "submittedOn" ? SPONSORSHIP_STAGE_LABELS.SUBMITTED : SPONSORSHIP_STAGE_LABELS.ACCEPTED;
      return `Saved. ${label} ${formatShortDate(change.filled.date)}.`;
    },
    { formData },
  );
}

export async function updateSponsorshipInfoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await updateSponsorshipInfo(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "Saved.", formData },
  );
}

/** Import pasted rows, then show the list with how many were added / updated / skipped. */
export async function importSponsorshipsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { added, updated, skipped } = await importSponsorships(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/sponsors?imported=${added}${updated > 0 ? `&updated=${updated}` : ""}&skipped=${skipped}`);
    },
    // No `formData`: the paste box keeps its own text, so a big paste isn't echoed back.
    {},
  );
}
