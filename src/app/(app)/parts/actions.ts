"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext, type ServiceContext } from "@/server/context";
import {
  claimPart,
  createPart,
  deletePart,
  finishPart,
  movePart,
  reopenPart,
  unclaimPart,
  updatePart,
} from "@/server/services/parts";

// Parts queue actions. Every service re-checks permissions and state from the database.

export async function createPartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createPart(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/parts#part-${encodeURIComponent(id)}`);
    },
    { formData },
  );
}

export async function updatePartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id, status } = await updatePart(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/parts${status === "DONE" ? "?view=done" : ""}#part-${encodeURIComponent(id)}`);
    },
    { formData },
  );
}

/** Remove from the edit page: back to the queue afterwards. */
export async function deletePartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await deletePart(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect("/parts");
    },
    { formData },
  );
}

/**
 * The buttons on a queue card (fields: partId, plus direction for moves). The page is refreshed even
 * when the action fails, so someone who lost a race sees who grabbed the part (or that it's gone).
 */
async function inline(formData: FormData, service: (ctx: ServiceContext, raw: unknown) => Promise<unknown>) {
  return runAction(async () => {
    const ctx = await getServiceContext();
    try {
      await service(ctx, formDataToObject(formData));
    } finally {
      revalidatePath("/", "layout");
    }
  });
}

export async function claimPartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, claimPart);
}

export async function unclaimPartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, unclaimPart);
}

export async function finishPartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, finishPart);
}

export async function reopenPartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, reopenPart);
}

export async function movePartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, movePart);
}

/** Remove from a queue card: the list stays put. */
export async function removePartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, deletePart);
}
