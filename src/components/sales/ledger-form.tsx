"use client";

import { useActionState, useEffect, useRef } from "react";
import { createLedgerEntryAction } from "@/app/(app)/resources/sales/actions";
import { initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";
import type { DateOnly } from "@/lib/dates";
import { LEDGER_KIND_LABELS, SALE_PAYMENT_LABELS, SALE_PAYMENTS } from "@/lib/sales";
import { Field, Input, Select } from "../ui/field";
import { FormMessage } from "../ui/form-message";
import { SubmitButton } from "../ui/submit-button";

/** Money in or out that isn't a register sale: supplies bought, a cash donation, the table fee… */
export function LedgerEntryForm({ today, events }: { today: DateOnly; events: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState(createLedgerEntryAction, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);
  const failed = state && !state.ok;
  const v = (k: string, fallback = "") => (failed ? (state.values?.[k] ?? fallback) : fallback);
  const err = state?.fieldErrors;
  return (
    <form ref={formRef} action={formAction} className="space-y-3" noValidate key={state?.ok ? state.nonce : "form"}>
      <FormMessage state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" htmlFor="entry-kind" error={err?.kind}>
          <Select id="entry-kind" name="kind" defaultValue={v("kind", "EXPENSE")}>
            <option value="EXPENSE">{LEDGER_KIND_LABELS.EXPENSE} (spent)</option>
            <option value="INCOME">{LEDGER_KIND_LABELS.INCOME} (not from the register)</option>
          </Select>
        </Field>
        <Field label="Amount ($)" htmlFor="entry-amount" error={err?.amount}>
          <Input id="entry-amount" name="amount" inputMode="decimal" defaultValue={v("amount")} invalid={!!err?.amount} placeholder="24.99" />
        </Field>
        <Field label="What it was for" htmlFor="entry-description" error={err?.description} className="sm:col-span-2">
          <Input id="entry-description" name="description" maxLength={LIMITS.ledgerDescriptionMax} defaultValue={v("description")} invalid={!!err?.description} placeholder="Flour, sugar, and napkins from Costco" />
        </Field>
        <Field label="Date" htmlFor="entry-date" error={err?.occurredOn}>
          <Input id="entry-date" name="occurredOn" type="date" defaultValue={v("occurredOn", today)} invalid={!!err?.occurredOn} />
        </Field>
        <Field label="Paid with" htmlFor="entry-payment" optional>
          <Select id="entry-payment" name="payment" defaultValue={v("payment")}>
            <option value="">—</option>
            {SALE_PAYMENTS.map((p) => (
              <option key={p} value={p}>
                {SALE_PAYMENT_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        {events.length > 0 && (
          <Field label="Fundraiser" htmlFor="entry-event" optional error={err?.fundraiserId} className="sm:col-span-2">
            <Select id="entry-event" name="fundraiserId" defaultValue={v("fundraiserId")}>
              <option value="">No fundraiser</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <SubmitButton pendingText="Adding…">Add to money book</SubmitButton>
    </form>
  );
}
