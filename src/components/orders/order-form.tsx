"use client";

import { useActionState, useRef } from "react";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { PurchaseStatus } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { LIMITS, PURCHASE_STATUS_LABELS, PURCHASE_STATUSES, SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";

export interface OrderFormValues {
  id?: string;
  description: string;
  notes: string;
  link: string;
  vendor: string;
  /** Whole number as text ("" = not given). */
  quantity: string;
  /** Dollars as text, like "12.99" ("" = not known yet). */
  cost: string;
  /** A subteam, or "" for the whole team. */
  subteam: string;
  /** "" = no one yet. */
  ordererId: string;
  /** Adding only (all-scope staff). */
  status?: PurchaseStatus;
  /** Editing: the item's last change (ISO), so a save over someone else's change is caught. */
  seen?: string;
}

export interface OrdererChoices {
  /** ACTIVE people a manager can pick. Empty = the viewer can't pick (they order it themselves). */
  people: { id: string; name: string }[];
  /** Editing: the current orderer when they can't be picked any more (they left the team). */
  current?: { id: string; name: string } | null;
  /** Shown instead of the menu to people who can't pick: who orders it. */
  fixedName?: string | null;
}

/**
 * Add / edit an item on the order list. Values survive validation errors (the fields remount with what was
 * sent) and focus goes to the first field to fix. The server checks everything (`noValidate`: no browser
 * bubbles), turns the price into cents, and adds https:// to a bare link like andymark.com/…
 */
export function OrderForm({
  action,
  initial,
  orderers,
  canPickStatus = false,
  submitLabel,
  cancelHref = "/orders",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: OrderFormValues;
  orderers: OrdererChoices;
  /** Adding, as all-scope staff: pick the status (e.g. something already bought). */
  canPickStatus?: boolean;
  submitLabel: string;
  cancelHref?: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);

  return (
    <form ref={formRef} action={formAction} className="space-y-5" noValidate>
      {initial.id && <input type="hidden" name="itemId" value={initial.id} />}
      {/* From the page, not what was sent: after "someone else changed it" the page catches up, so saving again keeps this version. */}
      {initial.seen && <input type="hidden" name="seen" value={initial.seen} />}
      <Card>
        <OrderFields key={state?.nonce ?? 0} state={state} initial={initial} orderers={orderers} canPickStatus={canPickStatus} />
      </Card>
      {/* Next to the button people just pressed (the form is long on phones). Success goes to the list. */}
      <FormMessage state={state && !state.ok ? state : null} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function OrderFields({
  state,
  initial,
  orderers,
  canPickStatus,
}: {
  state: ActionState;
  initial: OrderFormValues;
  orderers: OrdererChoices;
  canPickStatus: boolean;
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: keyof OrderFormValues) => v?.[key] ?? String(initial[key] ?? "");
  /** Props every control shares: name, error state, and the error's id for screen readers. */
  const control = (key: keyof OrderFormValues) => ({
    id: key,
    name: key,
    invalid: !!errors[key],
    "aria-describedby": errors[key] ? `${key}-error` : undefined,
    defaultValue: value(key),
  });
  const canPickOrderer = orderers.people.length > 0;

  return (
    <CardBody className="space-y-5">
      <Field label="Description" htmlFor="description" error={errors.description} hint="What to buy.">
        <Input
          {...control("description")}
          required
          maxLength={LIMITS.purchaseDescriptionMax}
          placeholder="e.g. Flywheels for the outtake"
          autoComplete="off"
        />
      </Field>

      <Field
        label="Link"
        htmlFor="link"
        error={errors.link}
        optional
        hint="The product page, so whoever orders it gets the right thing."
      >
        <Input
          {...control("link")}
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={LIMITS.resourceUrlMax}
          placeholder="https://"
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Vendor" htmlFor="vendor" error={errors.vendor} optional>
          <Input {...control("vendor")} maxLength={LIMITS.purchaseVendorMax} autoComplete="off" placeholder="e.g. AndyMark" />
        </Field>
        <Field label="Quantity" htmlFor="quantity" error={errors.quantity} optional>
          <Input
            {...control("quantity")}
            // Text, not type="number": whatever was typed reaches the server, which explains a bad value.
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            className="max-w-32"
          />
        </Field>
        <Field label="Cost ($)" htmlFor="cost" error={errors.cost} optional hint="The total for all of them, not the price of one.">
          <Input {...control("cost")} inputMode="decimal" autoComplete="off" placeholder="e.g. 24.99" className="max-w-40" />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="For" htmlFor="subteam" error={errors.subteam}>
          <Select {...control("subteam")}>
            <option value="">Whole team</option>
            {SUBTEAMS.map((s) => (
              <option key={s} value={s}>
                {SUBTEAM_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        {canPickOrderer ? (
          <Field label="Orderer" htmlFor="ordererId" error={errors.ordererId} hint="Who's buying it.">
            <Select {...control("ordererId")}>
              <option value="">No one yet</option>
              {orderers.current && (
                <option value={orderers.current.id}>{orderers.current.name} (no longer on the team)</option>
              )}
              {orderers.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-ink-800">Orderer</p>
            <p className="flex min-h-10 items-center text-sm text-ink-700 wrap-anywhere">{orderers.fixedName ?? "No one yet"}</p>
            <p className="text-xs text-ink-500">A leader can pick someone else.</p>
          </div>
        )}
      </div>

      {canPickStatus && (
        <Field
          label="Status"
          htmlFor="status"
          error={errors.status}
          hint="Leave it on Requested for things still to buy. Pick another status for something already approved or bought."
        >
          <Select {...control("status")} className="sm:max-w-60">
            {PURCHASE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PURCHASE_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Notes" htmlFor="notes" error={errors.notes} optional>
        <Textarea {...control("notes")} rows={3} maxLength={LIMITS.purchaseNotesMax} placeholder="SKU, size, color, where to find it… e.g. SKU am-5437 (2)" />
      </Field>
    </CardBody>
  );
}
