"use server";

import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { SPONSORSHIP_STAGE_LABELS } from "@/lib/constants";
import { bulkRemoveMessage, formatShortDate } from "@/lib/sponsorships";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { ConflictError } from "@/server/errors";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import { readFormFile } from "@/server/files/upload";
import { deleteSponsorshipFile, uploadSponsorshipFile } from "@/server/services/sponsorship-files";
import { removeSponsorshipLogo, uploadSponsorshipLogo } from "@/server/services/sponsorship-logos";
import {
  createSponsorship,
  deleteSponsorship,
  deleteSponsorships,
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
      scheduleFileCleanup(); // its files went with it
      revalidatePath("/", "layout");
      redirect(`/sponsors?removed=${encodeURIComponent(name)}`);
    },
    { formData },
  );
}

/**
 * "Remove selected" on the list (fields: sponsorshipIds[]). The list stays open and says what happened
 * ("Removed 12 sponsors."); when nothing could be removed, that's shown as a failure.
 */
export async function deleteSponsorshipsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const result = await deleteSponsorships(ctx, formDataToObject(formData));
    scheduleFileCleanup(); // their files went with them
    revalidatePath("/", "layout");
    const message = bulkRemoveMessage(result);
    if (result.removed.length === 0) throw new ConflictError(message);
    return message;
  });
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
      const saved = await updateSponsorshipInfo(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      return saved.mentionsPassword ? "Saved. It looks like there's a password in it — please take it out." : "Saved.";
    },
    { formData },
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

/**
 * The file card's actions also re-render the page when they fail: the error is often because the page is out of
 * date (another tab filled the sponsor up, or removed the file), and the card should show why.
 */
function refreshOnFailure(state: ActionState): ActionState {
  if (!state?.ok) refresh();
  return state;
}

/** Attach a file to a sponsor (its page stays open; the card says what was added). */
export async function uploadSponsorshipFileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await runAction(
    async () => {
      const ctx = await getServiceContext();
      const { filename } = await uploadSponsorshipFile(ctx, { ...formDataToObject(formData), file: await readFormFile(formData) });
      revalidatePath("/", "layout");
      return `Added “${filename}”.`;
    },
    { formData },
  );
  return refreshOnFailure(state);
}

/** Remove a sponsor's file. */
export async function deleteSponsorshipFileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await runAction(
    async () => {
      const ctx = await getServiceContext();
      const { filename } = await deleteSponsorshipFile(ctx, formDataToObject(formData));
      scheduleFileCleanup();
      revalidatePath("/", "layout");
      return `Removed “${filename}”.`;
    },
    { formData },
  );
  return refreshOnFailure(state);
}

/** Upload or replace a sponsor's logo for the team website (its page stays open; the section says what happened). */
export async function uploadSponsorshipLogoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await runAction(
    async () => {
      const ctx = await getServiceContext();
      const { replaced } = await uploadSponsorshipLogo(ctx, { ...formDataToObject(formData), file: await readFormFile(formData) });
      if (replaced) scheduleFileCleanup(); // the old logo's file
      revalidatePath("/", "layout");
      return replaced ? "Logo replaced." : "Logo added.";
    },
    { formData },
  );
  return refreshOnFailure(state);
}

/** Remove a sponsor's logo. */
export async function removeSponsorshipLogoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await runAction(
    async () => {
      const ctx = await getServiceContext();
      await removeSponsorshipLogo(ctx, formDataToObject(formData));
      scheduleFileCleanup();
      revalidatePath("/", "layout");
      return "Logo removed.";
    },
    { formData },
  );
  return refreshOnFailure(state);
}
