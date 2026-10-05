"use client";

import { CalendarCheck, Globe } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import type { CalendarEventKind } from "@/generated/prisma/enums";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, Field, FieldError, Input, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { CALENDAR_EVENT_KIND_LABELS, CALENDAR_EVENT_KINDS, LIMITS } from "@/lib/constants";
import { isPublicEventKind, PUBLIC_EVENT_KINDS_SENTENCE } from "@/lib/public-events";
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
  /** "Hide from the team website" (only offered for the kinds the website lists). */
  hideFromWebsite: boolean;
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
  from,
  websiteOff = false,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: CalendarEventFormValues;
  submitLabel: string;
  cancelHref: string;
  /** The date fields' range ("YYYY-MM-DD"), matching what the server accepts. */
  minDate: string;
  maxDate: string;
  /** Adding from Attendance (`?from=plan|schedule`): sent along, so the new event's page leads back there. */
  from?: string | null;
  /** The team website's Events page is turned off right now (Admin → Approvals → Team website): the website box says so. */
  websiteOff?: boolean;
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
      {from && <input type="hidden" name="from" value={from} />}
      <EventFields key={state?.nonce ?? 0} state={state} initial={initial} minDate={minDate} maxDate={maxDate} websiteOff={websiteOff} />
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
  websiteOff,
}: {
  state: ActionState;
  initial: CalendarEventFormValues;
  minDate: string;
  maxDate: string;
  websiteOff: boolean;
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: keyof CalendarEventFormValues) => v?.[key] ?? String(initial[key] ?? "");
  /** Props every text control shares: name, error state, and the error's id for screen readers. */
  const control = (key: keyof CalendarEventFormValues) => ({
    id: key,
    name: key,
    invalid: !!errors[key],
    "aria-describedby": errors[key] ? `${key}-error` : undefined,
    defaultValue: value(key),
  });
  // The kind picked right now (the radios stay uncontrolled): the title's example, the Extra meeting note, and the
  // team website box follow it.
  const [kind, setKind] = useState(value("kind"));
  const hideFromWebsite = v ? v.hideFromWebsite === "on" : initial.hideFromWebsite;
  const publicKind = isPublicEventKind(kind as CalendarEventKind);

  return (
    <>
      <Card>
        <CardHeader title="Event" />
        <CardBody className="space-y-5">
          <Field label="Title" htmlFor="title" error={errors.title}>
            <Input
              {...control("title")}
              required
              maxLength={LIMITS.calendarTitleMax}
              placeholder={kind === "MEETING" ? "e.g. Extra build day" : "e.g. League Meet 2"}
              autoComplete="off"
            />
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
                      defaultChecked={value("kind") === option}
                      onChange={() => setKind(option)}
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
            {/* Said as soon as "Extra meeting" is picked (the region stays, so screen readers hear it). */}
            <div aria-live="polite">
              {kind === "MEETING" && (
                <p className="mt-3 flex items-start gap-2 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-900">
                  <CalendarCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    An extra team meeting: that day, everyone&apos;s asked “Coming?” in Attendance, and attendance can be taken.
                  </span>
                </p>
              )}
            </div>
          </fieldset>

          {/* Always in the form (so switching kinds back and forth keeps the choice); shown for the kinds the team
              website lists. */}
          <div className={cn("rounded-lg border border-ink-200 bg-ink-50/60 p-3", !publicKind && "hidden")}>
            <CheckboxField
              name="hideFromWebsite"
              defaultChecked={hideFromWebsite}
              label="Hide from the team website"
              description={
                <>
                  The team website&apos;s Events page lists {PUBLIC_EVENT_KINDS_SENTENCE} from the Team calendar — the title,
                  days, times, location, and link, never the notes. Team meetings never go on it.
                </>
              }
            />
            {websiteOff && (
              <p className="mt-2 pl-7 text-sm text-ink-500">
                The Events page is turned off on the team website right now (Admin → Approvals → Team website): no events are shown
                there until it&apos;s turned on.
              </p>
            )}
          </div>
          {!publicKind && (
            <p className="flex items-start gap-2 text-sm text-ink-500">
              <Globe className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0">
                Not on the team website: only {PUBLIC_EVENT_KINDS_SENTENCE} are listed there (never team meetings).
              </span>
            </p>
          )}
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
          <Field
            label="Location"
            htmlFor="location"
            error={errors.location}
            optional
            hint={
              publicKind && !websiteOff
                ? "A venue name or an address (it opens in Maps). Shown on the team website unless it's hidden above — never someone's home."
                : "A venue name or an address (it opens in Maps)."
            }
          >
            <Input {...control("location")} maxLength={LIMITS.calendarLocationMax} placeholder="e.g. Anaheim High School, 811 W Lincoln Ave" autoComplete="off" />
          </Field>
          <Field
            label="Link"
            htmlFor="link"
            error={errors.link}
            optional
            hint={
              publicKind && !websiteOff
                ? "The FTC Events page, a sign-up form, or a flyer. Shown on the team website unless it's hidden above — only links anyone may open."
                : "The FTC Events page, a sign-up form, or a flyer."
            }
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
          <Field label="Notes" htmlFor="notes" error={errors.notes} optional hint="What to bring, when to arrive, who's driving…">
            <Textarea {...control("notes")} rows={4} maxLength={LIMITS.calendarNotesMax} />
          </Field>
        </CardBody>
      </Card>
    </>
  );
}
