"use client";

import { useActionState, useEffect, useRef } from "react";
import { updateRaisedAmountAction } from "@/app/(app)/fundraising/actions";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { Field, Input } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

/**
 * The quick "Update amount raised" box (Business team and leaders). After a save focus goes to the button
 * (also when it was sent with Enter from the field, which is replaced with the new amount) and a status
 * line confirms it; a bad amount keeps what was typed and focuses the field.
 */
export function RaisedAmountForm({ fundraiserId, raised }: { fundraiserId: string; raised: number }) {
  const [state, formAction] = useActionState(updateRaisedAmountAction, initialActionState);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const failed = !!state && !state.ok;
  const error = failed ? (state.fieldErrors?.raisedAmount ?? state.message) : undefined;

  useEffect(() => {
    if (!state) return;
    (state.ok ? buttonRef : inputRef).current?.focus();
  }, [state]);

  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="fundraiserId" value={fundraiserId} />
      <div className="flex flex-wrap items-start gap-2">
        <Field label="Amount raised so far ($)" htmlFor="raisedAmount" error={error} className="min-w-0 flex-1 sm:max-w-64">
          <Input
            key={state?.nonce ?? 0}
            ref={inputRef}
            id="raisedAmount"
            name="raisedAmount"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={failed ? (state.values?.raisedAmount ?? "") : String(raised)}
            invalid={!!error}
            aria-describedby={error ? "raisedAmount-error" : undefined}
          />
        </Field>
        {/* Lined up with the field (label height + gap). */}
        <SubmitButton ref={buttonRef} pendingText="Saving…" className="mt-[1.625rem]">
          Update amount
        </SubmitButton>
      </div>
      <p role="status" className={cn("text-xs font-medium text-brand-700", state?.ok && "mt-2")}>
        {state?.ok ? state.message : ""}
      </p>
    </form>
  );
}
