"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { formatCents } from "@/lib/orders";
import { SALE_STATUS_LABELS } from "@/lib/sales";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext, type ServiceContext } from "@/server/context";
import {
  createLedgerEntry,
  createSale,
  createSaleItem,
  deleteLedgerEntry,
  deleteSaleItem,
  markSaleServed,
  reopenSale,
  updateSaleItem,
  voidSale,
} from "@/server/services/sales";

// Sales actions (register, order queue, money book, menu). Every service re-checks permissions from the database.
// The pages stay put: each action refreshes them, also when it fails (someone else may have changed things).

async function run<T>(formData: FormData, service: (ctx: ServiceContext, raw: unknown) => Promise<T>, success: (result: T) => string) {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      try {
        return success(await service(ctx, formDataToObject(formData)));
      } finally {
        revalidatePath("/", "layout");
      }
    },
    { formData },
  );
}

export async function createSaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, createSale, (s) =>
    s.status === "OPEN"
      ? `Order #${s.number} (${formatCents(s.totalCents)}) is on the order queue.`
      : `Order #${s.number} saved: ${formatCents(s.totalCents)}.`,
  );
}

export async function markSaleServedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, markSaleServed, () => `Marked ${SALE_STATUS_LABELS.SERVED.toLowerCase()}.`);
}

export async function reopenSaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, reopenSale, () => "Back on the queue.");
}

export async function voidSaleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, voidSale, (s) => `Order #${s.number} voided.`);
}

export async function createSaleItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, createSaleItem, (i) => `${i.name} added to the menu.`);
}

export async function updateSaleItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, updateSaleItem, (i) => `${i.name} saved.`);
}

export async function deleteSaleItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, deleteSaleItem, () => "Removed from the menu.");
}

export async function createLedgerEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, createLedgerEntry, () => "Added to the money book.");
}

export async function deleteLedgerEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return run(formData, deleteLedgerEntry, () => "Entry removed.");
}
