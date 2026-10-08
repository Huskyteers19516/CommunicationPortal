"use client";

import { Minus, Plus, ShoppingBasket, Trash2 } from "lucide-react";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { createSaleAction } from "@/app/(app)/resources/sales/actions";
import type { SalePayment } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { formatCents, parseCents } from "@/lib/orders";
import { type CartLineInput, cartTotalCents, changeDueCents, SALE_PAYMENT_LABELS, SALE_PAYMENTS, saleCategoryLabel } from "@/lib/sales";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Field, Input, Select } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

interface MenuItem {
  id: string;
  name: string;
  category: string;
  priceCents: number;
}

interface CartLine {
  key: string;
  itemId: string | null;
  name: string;
  priceCents: number;
  quantity: number;
}

/** Remembered on this device: whether orders here usually need making (a food stand) or not (a bake-sale table). */
const QUEUE_KEY = "sales-register-queue";

function readQueuePref(): boolean {
  try {
    return window.localStorage.getItem(QUEUE_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * The register: tap menu items to build an order, pick how they paid, and save it. Prices shown here are only a
 * preview — the server prices every menu line from the database. On a phone a bar above the tab bar shows the
 * running total and jumps to the order.
 */
export function Register({
  items,
  events,
  defaultEventId,
}: {
  items: MenuItem[];
  events: { id: string; name: string }[];
  defaultEventId: string;
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payment, setPayment] = useState<SalePayment>("CASH");
  const [received, setReceived] = useState("");
  // A saved order clears the register for the next customer.
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await createSaleAction(prev, formData);
    if (result?.ok) {
      setCart([]);
      setReceived("");
    }
    return result;
  }, initialActionState);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLInputElement>(null);
  const customKey = useRef(0);

  useEffect(() => {
    if (queueRef.current) queueRef.current.checked = readQueuePref();
  }, []);

  useEffect(() => {
    if (!state) return;
    if (state.ok) formRef.current?.reset();
    if (queueRef.current) queueRef.current.checked = readQueuePref();
    statusRef.current?.focus();
  }, [state]);

  // The menu (refreshed after every save) wins: a hidden or removed item leaves the order, prices follow it.
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const lines: CartLine[] = cart.flatMap((l) => {
    if (!l.itemId) return [l];
    const item = byId.get(l.itemId);
    return item ? [{ ...l, name: item.name, priceCents: item.priceCents }] : [];
  });

  const groups = useMemo(() => {
    const map = new Map<string, MenuItem[]>();
    for (const i of items) {
      const label = saleCategoryLabel(i.category);
      map.set(label, [...(map.get(label) ?? []), i]);
    }
    return [...map.entries()];
  }, [items]);

  const total = cartTotalCents(lines);
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const receivedCents = received.trim() ? parseCents(received) : null;
  const change = receivedCents?.ok ? changeDueCents(total, receivedCents.value) : null;
  const short = receivedCents?.ok && receivedCents.value !== null && receivedCents.value < total;

  function add(item: MenuItem) {
    setCart((prev) => {
      const existing = prev.find((l) => l.itemId === item.id);
      if (existing) {
        return prev.map((l) => (l === existing ? { ...l, quantity: Math.min(l.quantity + 1, LIMITS.saleQuantityMax) } : l));
      }
      return [...prev, { key: item.id, itemId: item.id, name: item.name, priceCents: item.priceCents, quantity: 1 }];
    });
  }

  function change1(key: string, delta: number) {
    setCart((prev) =>
      prev.flatMap((l) => {
        if (l.key !== key) return [l];
        const quantity = Math.min(l.quantity + delta, LIMITS.saleQuantityMax);
        return quantity <= 0 ? [] : [{ ...l, quantity }];
      }),
    );
  }

  function addCustom() {
    const name = customName.trim();
    const price = parseCents(customPrice);
    if (!name) return setCustomError("Give it a name, like Donation.");
    if (!price.ok || price.value === null) return setCustomError(price.ok ? "Enter a price, like 5." : price.message);
    setCart((prev) => [...prev, { key: `custom-${++customKey.current}`, itemId: null, name, priceCents: price.value as number, quantity: 1 }]);
    setCustomName("");
    setCustomPrice("");
    setCustomError(null);
  }

  const payload: CartLineInput[] = lines.map((l) =>
    l.itemId ? { itemId: l.itemId, quantity: l.quantity } : { name: l.name, priceCents: l.priceCents, quantity: l.quantity },
  );
  const quantityCount = count.toLocaleString("en-US");

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="space-y-6">
        {groups.map(([label, list]) => (
          <section key={label} aria-label={label}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-600">{label}</h2>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {list.map((item) => {
                const inCart = lines.find((l) => l.itemId === item.id)?.quantity ?? 0;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => add(item)}
                      aria-label={`Add ${item.name}, ${formatCents(item.priceCents)}${inCart ? ` (${inCart} on the order)` : ""}`}
                      className={cn(
                        "relative flex min-h-20 w-full flex-col items-start justify-between rounded-xl border bg-white p-3 text-left shadow-sm transition-colors active:scale-[0.98]",
                        inCart ? "border-brand-400 bg-brand-50/60" : "border-ink-200 hover:border-brand-300",
                      )}
                    >
                      <span className="line-clamp-2 pr-6 text-sm font-semibold text-ink-900">{item.name}</span>
                      <span className="mt-1 text-sm tabular-nums text-ink-600">{formatCents(item.priceCents)}</span>
                      {inCart > 0 && (
                        <span className="absolute right-2 top-2 inline-flex min-w-6 items-center justify-center rounded-full bg-brand-600 px-1.5 text-xs font-bold leading-6 text-white tabular-nums">
                          {inCart}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        <section aria-labelledby="custom-heading" className="rounded-xl border border-dashed border-ink-300 p-3">
          <h2 id="custom-heading" className="mb-2 text-sm font-semibold text-ink-700">
            Something else (donation, special price…)
          </h2>
          <div className="flex flex-wrap items-start gap-2">
            <Input
              aria-label="What it is"
              placeholder="What it is"
              value={customName}
              maxLength={LIMITS.saleItemNameMax}
              onChange={(e) => setCustomName(e.target.value)}
              className="min-w-0 flex-[2_1_10rem]"
            />
            <Input
              aria-label="Price in dollars"
              placeholder="Price ($)"
              inputMode="decimal"
              value={customPrice}
              onChange={(e) => setCustomPrice(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
              className="min-w-0 flex-[1_1_6rem]"
            />
            <Button variant="secondary" onClick={addCustom}>
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
          {customError && <p className="mt-1 text-sm text-red-600">{customError}</p>}
        </section>
      </div>

      <Card id="cart" className="scroll-mt-20 lg:sticky lg:top-20">
        <CardHeader title="Order" description={count ? `${quantityCount} item${count === 1 ? "" : "s"}` : "Tap items to add them."} />
        <CardBody>
          <form ref={formRef} action={formAction} className="space-y-4" noValidate>
            <input type="hidden" name="lines" value={JSON.stringify(payload)} />
            <input type="hidden" name="payment" value={payment} />

            <div ref={statusRef} tabIndex={-1} className="outline-none" aria-live="polite">
              {state?.message && (
                <Alert tone={state.ok ? "success" : "error"} role={null}>
                  {state.message}
                </Alert>
              )}
            </div>

            {lines.length === 0 ? (
              <div className="flex flex-col items-center py-4 text-center text-sm text-ink-500">
                <ShoppingBasket className="mb-2 size-6 text-ink-300" aria-hidden />
                Nothing on this order yet.
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {lines.map((l) => (
                  <li key={l.key} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-900">{l.name}</p>
                      <p className="text-xs tabular-nums text-ink-500">
                        {formatCents(l.priceCents)} each · {formatCents(l.priceCents * l.quantity)}
                      </p>
                    </div>
                    <Button size="icon" variant="ghost" aria-label={l.quantity === 1 ? `Remove ${l.name}` : `One less ${l.name}`} onClick={() => change1(l.key, -1)}>
                      {l.quantity === 1 ? <Trash2 className="size-4" aria-hidden /> : <Minus className="size-4" aria-hidden />}
                    </Button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums" aria-label={`${l.quantity} ${l.name}`}>
                      {l.quantity}
                    </span>
                    <Button size="icon" variant="ghost" aria-label={`One more ${l.name}`} onClick={() => change1(l.key, 1)}>
                      <Plus className="size-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex items-baseline justify-between border-t border-ink-200 pt-3">
              <span className="text-sm font-medium text-ink-700">Total</span>
              <span className="font-display text-3xl font-semibold tabular-nums text-ink-900">{formatCents(total)}</span>
            </div>

            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-ink-800">Paid with</legend>
              <div className="grid grid-cols-3 gap-1.5">
                {SALE_PAYMENTS.map((p) => (
                  <label
                    key={p}
                    className={cn(
                      "flex h-10 cursor-pointer items-center justify-center rounded-lg border text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40",
                      payment === p ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 text-ink-700 hover:border-ink-300",
                    )}
                  >
                    <input type="radio" name="paymentChoice" value={p} checked={payment === p} onChange={() => setPayment(p)} className="sr-only" />
                    {SALE_PAYMENT_LABELS[p]}
                  </label>
                ))}
              </div>
            </fieldset>

            {payment === "CASH" && (
              <div className="rounded-lg bg-ink-50 p-3">
                <Field label="Cash received ($)" htmlFor="sale-received" optional>
                  <Input id="sale-received" inputMode="decimal" autoComplete="off" value={received} onChange={(e) => setReceived(e.target.value)} placeholder="e.g. 20" />
                </Field>
                <p className="mt-2 text-sm font-medium tabular-nums" aria-live="polite">
                  {change !== null ? (
                    <span className="text-brand-800">Change: {formatCents(change)}</span>
                  ) : short ? (
                    <span className="text-red-700">That&apos;s {formatCents(total - (receivedCents?.ok ? (receivedCents.value ?? 0) : 0))} short.</span>
                  ) : null}
                </p>
              </div>
            )}

            <Field label="Name for the order" htmlFor="sale-customer" optional hint="Called out when it's ready.">
              <Input id="sale-customer" name="customer" maxLength={LIMITS.saleCustomerMax} autoComplete="off" defaultValue={state?.ok ? "" : (state?.values?.customer ?? "")} />
            </Field>
            <Field label="Note" htmlFor="sale-note" optional>
              <Input id="sale-note" name="note" maxLength={LIMITS.saleNoteMax} autoComplete="off" placeholder="No nuts, extra ice…" defaultValue={state?.ok ? "" : (state?.values?.note ?? "")} />
            </Field>

            {events.length > 0 && (
              <Field label="Selling for" htmlFor="sale-event" optional>
                <Select id="sale-event" name="fundraiserId" defaultValue={defaultEventId}>
                  <option value="">No fundraiser</option>
                  {events.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <label className="flex min-h-10 cursor-pointer items-start gap-2 text-sm text-ink-800">
              <input
                type="checkbox"
                ref={queueRef}
                name="queue"
                defaultChecked
                onChange={(e) => {
                  try {
                    window.localStorage.setItem(QUEUE_KEY, e.target.checked ? "1" : "0");
                  } catch {}
                }}
                className="mt-0.5 size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
              />
              <span>
                Needs making
                <span className="block text-xs text-ink-500">Puts it on the Orders tab until someone marks it served.</span>
              </span>
            </label>

            <SubmitButton className="w-full" size="lg" disabled={lines.length === 0} pendingText="Saving…">
              {lines.length === 0 ? "Add items to charge" : `Charge ${formatCents(total)}`}
            </SubmitButton>
          </form>
        </CardBody>
      </Card>

      {lines.length > 0 && (
        // Phones: the running total above the tab bar, jumping to the order.
        <div data-sticky-action-bar="" className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-20 lg:hidden">
          <a
            href="#cart"
            className="flex items-center justify-between gap-3 rounded-xl border border-brand-300 bg-white/95 px-4 py-3 shadow-lg backdrop-blur"
          >
            <span className="text-sm font-medium text-ink-800">
              {quantityCount} item{count === 1 ? "" : "s"} · <span className="tabular-nums">{formatCents(total)}</span>
            </span>
            <span className="text-sm font-semibold text-brand-700">Review &amp; charge ↓</span>
          </a>
        </div>
      )}
    </div>
  );
}
