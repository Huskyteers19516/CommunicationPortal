"use client";

import { useActionState } from "react";
import { Field, Input } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";

type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Edit your display name. `hint`: what's under the field (default: where it's shown). */
export function ProfileForm({ action, name, hint = "Shown to your team on tasks and questions." }: { action: FormAction; name: string; hint?: string }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const error = state?.fieldErrors?.name;
  return (
    <form action={formAction} className="space-y-3">
      <Field label="Name" htmlFor="settings-name" error={error} hint={hint}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="settings-name"
            name="name"
            autoComplete="name"
            required
            maxLength={LIMITS.nameMax}
            defaultValue={state?.values?.name ?? name}
            invalid={!!error}
            // The input shares the Field with the Save button, so link the hint/error here.
            aria-describedby={error ? "settings-name-error" : "settings-name-hint"}
            className="sm:flex-1"
          />
          <SubmitButton pendingText="Saving…" className="sm:w-auto">
            Save name
          </SubmitButton>
        </div>
      </Field>
      {!error && <FormMessage state={state} />}
    </form>
  );
}
