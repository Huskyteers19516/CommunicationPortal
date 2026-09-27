"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formatDateOnly, todayInTimezone } from "@/lib/dates";
import { formatDollars } from "@/lib/money";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext, type ServiceContext } from "@/server/context";
import { env } from "@/server/env";
import {
  createFundraiser,
  deleteFundraiser,
  removeVolunteer,
  unvolunteer,
  updateFundraiser,
  updateRaisedAmount,
  updateSeasonGoal,
  volunteer,
} from "@/server/services/fundraising";

// Fundraising actions. Every service re-checks permissions and state from the database.

export async function createFundraiserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createFundraiser(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/fundraising/${encodeURIComponent(id)}?added=1`);
    },
    { formData },
  );
}

/**
 * The page is refreshed even when the save fails: the form then carries the newest amount raised, so after
 * "The amount raised was changed…" saving again goes through (the typed values are kept).
 */
export async function updateFundraiserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      let id: string;
      try {
        ({ id } = await updateFundraiser(ctx, formDataToObject(formData)));
      } finally {
        revalidatePath("/", "layout");
      }
      redirect(`/fundraising/${encodeURIComponent(id)}?saved=1`);
    },
    { formData },
  );
}

export async function deleteFundraiserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { name } = await deleteFundraiser(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/fundraising?removed=${encodeURIComponent(name)}`);
    },
    { formData },
  );
}

/**
 * Inline buttons and boxes (the page stays put). The page is refreshed even when the action fails, so
 * someone who lost the race for the last spot sees the list as it is now. `echo` sends typed values back
 * on failure (boxes with an input).
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

export async function volunteerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, volunteer, () => "Thanks for helping! You're on the list.");
}

export async function unvolunteerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, unvolunteer, () => "You left this fundraiser.");
}

export async function removeVolunteerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, removeVolunteer, ({ name }) => `Took ${name} off the helper list.`);
}

export async function updateRaisedAmountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, updateRaisedAmount, ({ raisedAmount }) => `Saved — ${formatDollars(raisedAmount)} raised so far.`, true);
}

export async function updateSeasonGoalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(
    formData,
    updateSeasonGoal,
    ({ goal, seasonStart }) => {
      const set = goal === null ? "Season goal cleared" : `Season goal set to ${formatDollars(goal)}`;
      if (!seasonStart) return `${set}. Counting every fundraiser.`;
      return `${set}, counting fundraisers since ${formatDateOnly(seasonStart, todayInTimezone(env.teamTimezone))}.`;
    },
    true,
  );
}
