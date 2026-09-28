"use server";

import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { PURCHASE_STATUS_LABELS } from "@/lib/constants";
import { filterForStatus, ordersHref } from "@/lib/orders";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { createOrder, deleteOrder, OrderEditConflictError, setOrderStatus, updateOrder } from "@/server/services/orders";

// Order list actions. Every service re-checks permissions and state from the database.

/** Add an item, then show it in the list it lands in ("?added=<id>": highlighted and focused). */
export async function createOrderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id, status } = await createOrder(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(ordersHref({ filter: filterForStatus(status) }, { added: id }));
    },
    { formData },
  );
}

/**
 * Save the edit form, then show the item in the list ("?saved=<id>"). When someone else saved a change first, the
 * page is refreshed (the form keeps what was typed, the hidden `seen` catches up), so saving again keeps this
 * version. Other refusals don't refresh: the form stays up with the reason.
 */
export async function updateOrderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let conflict = false;
  const state = await runAction(
    async () => {
      const ctx = await getServiceContext();
      try {
        const { id, status } = await updateOrder(ctx, formDataToObject(formData));
        revalidatePath("/", "layout");
        redirect(ordersHref({ filter: filterForStatus(status) }, { saved: id }));
      } catch (e) {
        conflict = e instanceof OrderEditConflictError;
        throw e;
      }
    },
    { formData },
  );
  if (conflict) refresh();
  return state;
}

/** Remove an item, then say so on the list, on the tab it was on ("?removed=1"). */
export async function deleteOrderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { status } = await deleteOrder(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(ordersHref({ filter: filterForStatus(status) }, { removed: "1" }));
    },
    { formData },
  );
}

/**
 * The status menu (list rows and the item's page). When it fails, the page is refreshed too: the error is
 * usually because the page is out of date (someone else changed the status, or the item is gone).
 */
export async function setOrderStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await runAction(async () => {
    const ctx = await getServiceContext();
    const change = await setOrderStatus(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    return change.changed ? "Saved." : `Already ${PURCHASE_STATUS_LABELS[change.status]}.`;
  });
  if (!state?.ok) refresh();
  return state;
}
