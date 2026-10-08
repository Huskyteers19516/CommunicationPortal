"use client";

import { useActionState, useEffect, useRef } from "react";
import { createSaleItemAction, deleteSaleItemAction, updateSaleItemAction } from "@/app/(app)/resources/sales/actions";
import { initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";
import { centsToInput, formatCents } from "@/lib/orders";
import { saleCategoryLabel } from "@/lib/sales";
import { Badge } from "../ui/badge";
import { Field, Input } from "../ui/field";
import { FormMessage } from "../ui/form-message";
import { SubmitButton } from "../ui/submit-button";
import { SalesActionButton } from "./action-button";

/** Datalist id shared by the menu forms, so categories already in use are suggested. */
const CATEGORY_LIST = "sale-categories";

export function CategoryOptions({ categories }: { categories: string[] }) {
  return (
    <datalist id={CATEGORY_LIST}>
      {categories.map((c) => (
        <option key={c} value={c} />
      ))}
    </datalist>
  );
}

/** "Add to the menu": clears itself after each item, so a whole menu goes in quickly. */
export function AddMenuItemForm() {
  const [state, formAction] = useActionState(createSaleItemAction, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      nameRef.current?.focus();
    }
  }, [state]);
  const failed = state && !state.ok;
  const v = (k: string) => (failed ? (state.values?.[k] ?? "") : undefined);
  return (
    <form ref={formRef} action={formAction} className="space-y-3" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-3 sm:grid-cols-[2fr_1.5fr_1fr_auto] sm:items-start">
        <Field label="Name" htmlFor="item-name" error={state?.fieldErrors?.name}>
          <Input ref={nameRef} id="item-name" name="name" maxLength={LIMITS.saleItemNameMax} defaultValue={v("name")} invalid={!!state?.fieldErrors?.name} placeholder="Chocolate chip cookie" key={`n${state?.nonce}`} />
        </Field>
        <Field label="Category" htmlFor="item-category" optional error={state?.fieldErrors?.category}>
          <Input id="item-category" name="category" list={CATEGORY_LIST} maxLength={LIMITS.saleItemCategoryMax} defaultValue={v("category")} placeholder="Baked goods" key={`c${state?.nonce}`} />
        </Field>
        <Field label="Price ($)" htmlFor="item-price" error={state?.fieldErrors?.price}>
          <Input id="item-price" name="price" inputMode="decimal" defaultValue={v("price")} invalid={!!state?.fieldErrors?.price} placeholder="2.50" key={`p${state?.nonce}`} />
        </Field>
        <SubmitButton pendingText="Adding…" className="sm:mt-[1.625rem]">
          Add
        </SubmitButton>
      </div>
    </form>
  );
}

export interface MenuRowItem {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  active: boolean;
}

/** One menu item: shown as a row, edited in place. */
export function MenuItemRow({ item }: { item: MenuRowItem }) {
  const [state, formAction] = useActionState(updateSaleItemAction, initialActionState);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (state?.ok && detailsRef.current) detailsRef.current.open = false;
  }, [state]);
  const id = `item-${item.id}`;
  return (
    <li className="py-3">
      <details ref={detailsRef} className="group">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="font-medium text-ink-900">{item.name}</span>
            <span className="ml-2 text-xs text-ink-500">{saleCategoryLabel(item.category)}</span>
            {!item.active && (
              <Badge tone="gray" className="ml-2">
                Hidden
              </Badge>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-3">
            <span className="tabular-nums text-ink-800">{formatCents(item.priceCents)}</span>
            <span className="text-sm font-medium text-brand-700 group-open:hidden">Edit</span>
          </span>
        </summary>
        <form action={formAction} className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3" noValidate>
          <input type="hidden" name="itemId" value={item.id} />
          <FormMessage state={state?.ok ? null : state} />
          <div className="grid gap-3 sm:grid-cols-[2fr_1.5fr_1fr]">
            <Field label="Name" htmlFor={`${id}-name`} error={state?.fieldErrors?.name}>
              <Input id={`${id}-name`} name="name" maxLength={LIMITS.saleItemNameMax} defaultValue={item.name} />
            </Field>
            <Field label="Category" htmlFor={`${id}-category`} optional>
              <Input id={`${id}-category`} name="category" list={CATEGORY_LIST} maxLength={LIMITS.saleItemCategoryMax} defaultValue={item.category} />
            </Field>
            <Field label="Price ($)" htmlFor={`${id}-price`} error={state?.fieldErrors?.price}>
              <Input id={`${id}-price`} name="price" inputMode="decimal" defaultValue={centsToInput(item.priceCents)} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-800">
            <input type="checkbox" name="active" defaultChecked={item.active} className="size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500" />
            On the register (untick to hide it, e.g. sold out)
          </label>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <SubmitButton size="sm" pendingText="Saving…">
              Save
            </SubmitButton>
          </div>
        </form>
        <SalesActionButton
          action={deleteSaleItemAction}
          fields={{ itemId: item.id }}
          variant="ghost"
          className="mt-2"
          confirm={`Remove ${item.name} from the menu? Past orders keep it. To bring it back later, hide it instead.`}
        >
          Remove from menu
        </SalesActionButton>
      </details>
    </li>
  );
}
