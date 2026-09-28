"use client";

import { useActionState, useRef } from "react";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";

export interface LeagueTeamFormValues {
  id?: string;
  /** "" for a new team. */
  number: string;
  name: string;
  city: string;
}

/** Add / edit one of the other teams in the league (people with admin access). Values survive errors. */
export function LeagueTeamForm({
  action,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: LeagueTeamFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);
  const errors = state?.fieldErrors ?? {};
  const value = (key: "number" | "name" | "city") => state?.values?.[key] ?? initial[key];
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);

  return (
    <form ref={formRef} action={formAction} className="space-y-6" noValidate>
      <FormMessage state={state} />
      {initial.id && <input type="hidden" name="teamId" value={initial.id} />}
      <Card>
        {/* Remounts with what was sent after an error, so nothing typed is lost. */}
        <CardBody key={state?.nonce ?? 0} className="space-y-5">
          <Field label="Team number" htmlFor="number" error={errors.number}>
            <Input
              id="number"
              name="number"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              required
              defaultValue={value("number")}
              invalid={!!errors.number}
              aria-describedby={described("number")}
              placeholder="e.g. 9040"
              className="max-w-40"
            />
          </Field>
          <Field label="Team name" htmlFor="name" error={errors.name}>
            <Input
              id="name"
              name="name"
              required
              maxLength={LIMITS.leagueTeamNameMax}
              defaultValue={value("name")}
              invalid={!!errors.name}
              aria-describedby={described("name")}
              placeholder="e.g. STEAMpunks Alpha"
              autoComplete="off"
            />
          </Field>
          <Field label="City" htmlFor="city" error={errors.city} optional>
            <Input
              id="city"
              name="city"
              maxLength={LIMITS.leagueTeamCityMax}
              defaultValue={value("city")}
              invalid={!!errors.city}
              aria-describedby={described("city")}
              placeholder="e.g. Irvine"
              autoComplete="off"
            />
          </Field>
        </CardBody>
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
