"use client";

import { useActionState, useEffect, useRef } from "react";
import type { CalendarEventKind } from "@/generated/prisma/enums";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FieldError, Input, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { CALENDAR_EVENT_KIND_LABELS, CALENDAR_EVENT_KINDS, LIMITS } from "@/lib/constants";
import { CALENDAR_KIND_HINTS, CALENDAR_KIND_ICONS, KindDot } from "./kind-styles";

export interface CalendarEventFormValues {
  id?: string;
  /** Editing: the event's updatedAt when the form was opened (sent back as `version`). */
  version?: string;
  title: string;
  kind: CalendarEventKind;
  /** "YYYY-MM-DD" or "". */
  startsOn: string;
  endsOn: string;
  /** "HH:MM" or "". */
  startTime: string;
  endTime: string;
  location: string;
  link: string;
  notes: string;
}

/**
 * Add / edit a calendar event (staff). Values survive errors (the fields remount with what was sent), focus goes
 * to the first field to fix — or to the message when it isn't about one field (e.g. someone else saved first) —
 * and the server explains problems inline (`noValidate`). Editing sends `version`; after a conflict the page
 * refreshes it, so saving again replaces the other change.
 */
export function CalendarEventForm({
  action,
  initial,
  submitLabel,
  cancelHref,
  minDate,
  maxDate,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: CalendarEventFormValues;
  submitLabel: string;
  cancelHref: string;
  /** The date fields' range ("YYYY-MM-DD"), matching what the server accepts. */
  minDate: string;
  maxDate: string;
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
      {initial.id && <input type="hidden" name="eventId" value={initial.id} />}
      {initial.version && <input type="hidden" name="version" value={initial.version} />}
      <EventFields key={state?.nonce ?? 0} state={state} initial={initial} minDate={minDate} maxDate={maxDate} />
      {state && !state.ok && state.message && (
        <div ref={messageRef} tabIndex={-1} className="rounded-lg">
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

function EventFields({
  state,
  initial,
  minDate,
  maxDate,
}: {
  state: ActionState;
  initial: CalendarEventFormValues;
  minDate: string;
  maxDate: string;
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: keyof CalendarEventFormValues) => v?.[key] ?? initial[key] ?? "";
  /** Props every text control shares: name, error state, and the error's id for screen readers. */
  const control = (key: keyof CalendarEventFormValues) => ({
    id: key,
    name: key,
    invalid: !!errors[key],
    "aria-describedby": errors[key] ? `${key}-error` : undefined,
    defaultValue: value(key),
  });
  const kind = value("kind");

  return (
    <>
      <Card>
        <CardHeader title="Event" />
        <CardBody className="space-y-5">
          <Field label="Title" htmlFor="title" error={errors.title}>
            <Input {...control("title")} required maxLength={LIMITS.calendarTitleMax} placeholder="e.g. League Meet 2" autoComplete="off" />
          </Field>

          <fieldset aria-describedby={errors.kind ? "kind-error" : undefined}>
            <legend className="text-sm font-medium text-ink-800">Kind</legend>
            {/* Two columns at every width, so labels like "Competition" fit a phone's card in full. */}
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {CALENDAR_EVENT_KINDS.map((option, i) => {
                const Icon = CALENDAR_KIND_ICONS[option];
                return (
                  <label
                    key={option}
                    className={cn(
                      "flex min-h-14 cursor-pointer items-start gap-2.5 rounded-lg border border-ink-200 bg-white p-3 text-sm shadow-sm transition-colors hover:border-brand-300",
                      "has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50 has-[:checked]:ring-1 has-[:checked]:ring-brand-500",
                      "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40",
                    )}
                  >
                    <input
                      type="radio"
                      name="kind"
                      value={option}
                      defaultChecked={kind === option}
                      required
                      // Radios can't take aria-invalid; this marks where focus goes after a "kind" error.
                      data-invalid={errors.kind && i === 0 ? "true" : undefined}
                      className="mt-0.5 size-4 shrink-0 accent-brand-600"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start gap-1.5 font-medium text-ink-900">
                        {/* The icon only from `sm` up: on a phone the label gets the card's whole width. */}
                        <Icon className="mt-0.5 hidden size-4 shrink-0 text-ink-600 sm:block" aria-hidden />
                        <span className="min-w-0 break-words">{CALENDAR_EVENT_KIND_LABELS[option]}</span>
                      </span>
                      <span className="mt-0.5 flex items-start gap-1.5 text-xs text-ink-500">
                        <KindDot kind={option} className="mt-[3px]" />
                        <span className="min-w-0">{CALENDAR_KIND_HINTS[option]}</span>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <FieldError id="kind-error">{errors.kind}</FieldError>
          </fieldset>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="When" description="Times are in the team's time zone. Leave them empty for an all-day event." />
        <CardBody className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Date" htmlFor="startsOn" error={errors.startsOn}>
              <Input {...control("startsOn")} type="date" required min={minDate} max={maxDate} className="sm:max-w-48" />
            </Field>
            <Field label="Last day" htmlFor="endsOn" error={errors.endsOn} optional hint="Only for events that last more than one day.">
              <Input {...control("endsOn")} type="date" min={minDate} max={maxDate} className="sm:max-w-48" />
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Start time" htmlFor="startTime" error={errors.startTime} optional hint="Leave empty for all day.">
              <Input {...control("startTime")} type="time" className="sm:max-w-48" />
            </Field>
            <Field
              label="End time"
              htmlFor="endTime"
              error={errors.endTime}
              optional
              hint="On a multi-day event, the start time is on the first day and the end time on the last day."
            >
              <Input {...control("endTime")} type="time" className="sm:max-w-48" />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Details" />
        <CardBody className="space-y-5">
          <Field label="Location" htmlFor="location" error={errors.location} optional hint="A venue name or an address (it opens in Maps).">
            <Input {...control("location")} maxLength={LIMITS.calendarLocationMax} placeholder="e.g. Anaheim High School, 811 W Lincoln Ave" autoComplete="off" />
          </Field>
          <Field label="Link" htmlFor="link" error={errors.link} optional hint="The FTC Events page, a sign-up form, or a flyer.">
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
          <Field label="Notes" htmlFor="notes" error={errors.notes} optional hint="What to bring, when to arrive, who's driving…">
            <Textarea {...control("notes")} rows={4} maxLength={LIMITS.calendarNotesMax} />
          </Field>
        </CardBody>
      </Card>
    </>
  );
}
