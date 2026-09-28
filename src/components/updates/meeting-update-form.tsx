"use client";

import { useActionState, useEffect, useRef } from "react";
import { SubteamBadge } from "@/components/app/badges";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, FieldError, Input, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { Subteam } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS, SUBTEAM_LABELS } from "@/lib/constants";

export interface MeetingUpdateFormValues {
  /** Editing: the update's id and the updatedAt (ISO) the form loaded, sent back as `version`. */
  id?: string;
  version?: string;
  /** "YYYY-MM-DD". */
  meetingDate: string;
  /** "" = not picked yet. */
  subteam: Subteam | "";
  body: string;
  nextSteps: string;
  blockers: string;
}

const SUBTEAM_HINTS: Record<Subteam, string> = {
  SOFTWARE: "Code, autonomous, driver controls",
  BUILD: "CAD, building, the robot itself",
  BUSINESS: "Outreach, sponsors, fundraising",
};

/**
 * Write / edit a meeting update. Values survive validation errors (the fields remount with what was sent),
 * focus goes to the first field to fix — or to the message when it isn't about one field (e.g. someone
 * else changed the update meanwhile) — and the server explains problems inline (`noValidate`).
 */
export function MeetingUpdateForm({
  action,
  initial,
  subteams,
  submitLabel,
  minDate,
  maxDate,
  cancelHref = "/updates",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: MeetingUpdateFormValues;
  /** The subteams it can be for. Just one: shown as text (sent as a hidden field). */
  subteams: Subteam[];
  submitLabel: string;
  /** The date field's range ("YYYY-MM-DD"), matching what the server accepts. */
  minDate: string;
  maxDate: string;
  /** Where "Cancel" goes (editing: back to the update on the feed). */
  cancelHref?: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  useFocusFirstError(state, formRef);
  useEffect(() => {
    if (state && !state.ok && Object.keys(state.fieldErrors ?? {}).length === 0) messageRef.current?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-5" noValidate>
      {initial.id && <input type="hidden" name="updateId" value={initial.id} />}
      {initial.version && <input type="hidden" name="version" value={initial.version} />}
      <Card>
        <UpdateFields
          key={state?.nonce ?? 0}
          state={state}
          initial={initial}
          subteams={subteams}
          minDate={minDate}
          maxDate={maxDate}
        />
      </Card>
      {/* Next to the button people just pressed (the form is long on phones). Success goes to the feed. */}
      {state && !state.ok && state.message && (
        <div ref={messageRef} tabIndex={-1} className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40">
          <FormMessage state={state} />
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function UpdateFields({
  state,
  initial,
  subteams,
  minDate,
  maxDate,
}: {
  state: ActionState;
  initial: MeetingUpdateFormValues;
  subteams: Subteam[];
  minDate: string;
  maxDate: string;
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: "meetingDate" | "subteam" | "body" | "nextSteps" | "blockers") => v?.[key] ?? initial[key] ?? "";
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);
  const subteam = value("subteam");
  const only = subteams.length === 1 ? subteams[0] : null;

  return (
    <CardBody className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Meeting date" htmlFor="meetingDate" error={errors.meetingDate}>
          <Input
            id="meetingDate"
            name="meetingDate"
            type="date"
            required
            min={minDate}
            max={maxDate}
            defaultValue={value("meetingDate")}
            invalid={!!errors.meetingDate}
            aria-describedby={described("meetingDate")}
            className="max-w-48"
          />
        </Field>

        {only && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-ink-800">Subteam</p>
            <p className="flex h-10 items-center">
              <SubteamBadge subteam={only} />
            </p>
            <input type="hidden" name="subteam" value={only} />
            <FieldError id="subteam-error">{errors.subteam}</FieldError>
          </div>
        )}
      </div>

      {!only && (
        <fieldset aria-describedby={described("subteam")}>
          <legend className="text-sm font-medium text-ink-800">Subteam</legend>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
            {subteams.map((option, i) => (
              <label
                key={option}
                className={cn(
                  "flex min-h-14 cursor-pointer items-start gap-2.5 rounded-lg border bg-white p-3 text-sm shadow-sm transition-colors hover:border-brand-300",
                  // Red like the other fields when no subteam was picked.
                  errors.subteam ? "border-red-400" : "border-ink-200",
                  "has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50 has-[:checked]:ring-1 has-[:checked]:ring-brand-500",
                  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40",
                )}
              >
                <input
                  type="radio"
                  name="subteam"
                  value={option}
                  defaultChecked={subteam === option}
                  required
                  // Radios can't take aria-invalid; this marks where focus goes after a "subteam" error.
                  data-invalid={errors.subteam && i === 0 ? "true" : undefined}
                  className="mt-0.5 size-4 shrink-0 accent-brand-600"
                />
                <span className="min-w-0">
                  <span className="block font-medium text-ink-900">{SUBTEAM_LABELS[option]}</span>
                  <span className="mt-0.5 block text-xs text-ink-500">{SUBTEAM_HINTS[option]}</span>
                </span>
              </label>
            ))}
          </div>
          <FieldError id="subteam-error">{errors.subteam}</FieldError>
        </fieldset>
      )}

      <Field label="What we did" htmlFor="body" error={errors.body} hint="What the subteam worked on and got done at this meeting.">
        <Textarea
          id="body"
          name="body"
          rows={6}
          required
          maxLength={LIMITS.meetingUpdateBodyMax}
          defaultValue={value("body")}
          invalid={!!errors.body}
          aria-describedby={described("body")}
          placeholder="e.g. Finished the intake CAD and printed the first roller hubs."
        />
      </Field>

      <Field label="Next time" htmlFor="nextSteps" error={errors.nextSteps} optional>
        <Textarea
          id="nextSteps"
          name="nextSteps"
          rows={3}
          maxLength={LIMITS.meetingUpdateNextMax}
          defaultValue={value("nextSteps")}
          invalid={!!errors.nextSteps}
          aria-describedby={described("nextSteps")}
          placeholder="What's the plan for the next meeting?"
        />
      </Field>

      <Field
        label="Problems or help needed"
        htmlFor="blockers"
        error={errors.blockers}
        optional
        hint="Anything broken, missing, or stuck — leaders read these."
      >
        <Textarea
          id="blockers"
          name="blockers"
          rows={3}
          maxLength={LIMITS.meetingUpdateBlockersMax}
          defaultValue={value("blockers")}
          invalid={!!errors.blockers}
          aria-describedby={described("blockers")}
          placeholder="e.g. Out of M3 screws; need help tuning the lift PID."
        />
      </Field>
    </CardBody>
  );
}
