"use client";

import { useActionState, useRef } from "react";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";

export interface PlannerPathFormValues {
  id: string;
  /** The updatedAt the page loaded (ISO): a save over a newer change is refused once. */
  version: string;
  name: string;
  notes: string;
  /** "" = ours, otherwise the other team's number. */
  teamNumber: string;
}

/**
 * Rename a saved path, change its notes, or whose path it is (the path itself is changed in the planner). Values
 * survive errors; the version always comes from the page, so after a conflict (the page refreshes) saving again
 * replaces the newer version.
 */
export function PlannerPathForm({
  action,
  initial,
  teams,
  from,
  cancelHref,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: PlannerPathFormValues;
  teams: { number: number; name: string }[];
  from: "paths" | "team";
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);
  const errors = state?.fieldErrors ?? {};
  const value = (key: "name" | "notes" | "teamNumber") => state?.values?.[key] ?? initial[key];
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);

  return (
    <form ref={formRef} action={formAction} className="space-y-6" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="pathId" value={initial.id} />
      <input type="hidden" name="version" value={initial.version} />
      <input type="hidden" name="from" value={from} />
      <Card>
        {/* Remounts with what was sent after an error, so nothing typed is lost. */}
        <CardBody key={state?.nonce ?? 0} className="space-y-5">
          <Field label="Name" htmlFor="name" error={errors.name}>
            <Input
              id="name"
              name="name"
              required
              maxLength={LIMITS.plannerPathNameMax}
              defaultValue={value("name")}
              invalid={!!errors.name}
              aria-describedby={described("name")}
              autoComplete="off"
            />
          </Field>
          <Field label="Whose path" htmlFor="teamNumber" error={errors.teamNumber} hint="Ours, or another team's auto you traced.">
            <Select
              id="teamNumber"
              name="teamNumber"
              defaultValue={value("teamNumber")}
              invalid={!!errors.teamNumber}
              aria-describedby={described("teamNumber")}
            >
              <option value="">Ours</option>
              {teams.map((t) => (
                <option key={t.number} value={String(t.number)}>
                  {t.number} · {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Notes" htmlFor="notes" error={errors.notes} optional>
            <Textarea
              id="notes"
              name="notes"
              rows={4}
              maxLength={LIMITS.plannerPathNotesMax}
              defaultValue={value("notes")}
              invalid={!!errors.notes}
              aria-describedby={described("notes")}
              placeholder="Where it starts, what it scores, how long it takes…"
            />
          </Field>
        </CardBody>
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Saving…">Save changes</SubmitButton>
      </div>
    </form>
  );
}
