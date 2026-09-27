"use client";

import { useActionState, useEffect, useRef } from "react";
import type { FundraiserKind, FundraiserStatus } from "@/generated/prisma/enums";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FieldError, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { FUNDRAISER_KIND_LABELS, FUNDRAISER_KINDS, FUNDRAISER_STATUS_LABELS, FUNDRAISER_STATUSES, LIMITS } from "@/lib/constants";
import type { LeadOption, LeadOptionGroup } from "@/server/queries/fundraising";
import { FUNDRAISER_KIND_HINTS, FUNDRAISER_KIND_ICONS } from "./fundraiser-badges";

export interface FundraiserFormValues {
  id?: string;
  name: string;
  kind: FundraiserKind;
  status: FundraiserStatus;
  description: string;
  location: string;
  link: string;
  /** "YYYY-MM-DD" or "". */
  startsOn: string;
  endsOn: string;
  /** Whole dollars as text, "" = none. Editing: the amount in the database (sent back as `loadedRaisedAmount`). */
  goalAmount: string;
  raisedAmount: string;
  /** "" = no one yet. */
  leadId: string;
  /** "" = no limit. */
  volunteerLimit: string;
}

/**
 * Add / edit a fundraiser (Business team and leaders). Values survive errors (the fields remount with what
 * was sent), focus goes to the first field to fix — or to the message when it isn't about one field — and
 * the server explains problems inline (`noValidate`). Editing sends the amount raised it loaded, so a newer
 * amount (from the quick box) isn't undone; the page refreshes it after a failed save.
 */
export function FundraiserForm({
  action,
  initial,
  leadGroups,
  currentLead,
  submitLabel,
  cancelHref,
  minDate,
  maxDate,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: FundraiserFormValues;
  leadGroups: LeadOptionGroup[];
  /** Editing: the current lead when they can't be picked any more (they left the team). */
  currentLead?: LeadOption | null;
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
  // An error that isn't about one field (e.g. the fundraiser was removed): the fields just remounted, so
  // focus would be lost — put it on the message.
  useEffect(() => {
    if (state && !state.ok && Object.keys(state.fieldErrors ?? {}).length === 0) messageRef.current?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-5" noValidate>
      {initial.id && <input type="hidden" name="fundraiserId" value={initial.id} />}
      {initial.id && <input type="hidden" name="loadedRaisedAmount" value={initial.raisedAmount} />}
      <FundraiserFields
        key={state?.nonce ?? 0}
        state={state}
        initial={initial}
        leadGroups={leadGroups}
        currentLead={currentLead}
        minDate={minDate}
        maxDate={maxDate}
      />
      {/* Next to the button people just pressed (the form is long on phones). Success goes to the fundraiser's page. */}
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

function FundraiserFields({
  state,
  initial,
  leadGroups,
  currentLead,
  minDate,
  maxDate,
}: {
  state: ActionState;
  initial: FundraiserFormValues;
  leadGroups: LeadOptionGroup[];
  currentLead?: LeadOption | null;
  minDate: string;
  maxDate: string;
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: keyof FundraiserFormValues) => v?.[key] ?? initial[key] ?? "";
  /** Props every text control shares: name, error state, and the error's id for screen readers. */
  const control = (key: keyof FundraiserFormValues) => ({
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
        <CardHeader title="Fundraiser" />
        <CardBody className="space-y-5">
          <Field label="Name" htmlFor="name" error={errors.name}>
            <Input {...control("name")} required maxLength={LIMITS.fundraiserNameMax} placeholder="e.g. Car wash at Anaheim High" autoComplete="off" />
          </Field>

          <fieldset aria-describedby={errors.kind ? "kind-error" : undefined}>
            <legend className="text-sm font-medium text-ink-800">Kind</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2 lg:grid-cols-4">
              {FUNDRAISER_KINDS.map((option, i) => {
                const Icon = FUNDRAISER_KIND_ICONS[option];
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
                      // Radios can't take aria-invalid; this marks where focus goes after a "kind" error.
                      data-invalid={errors.kind && i === 0 ? "true" : undefined}
                      className="mt-0.5 size-4 shrink-0 accent-brand-600"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-medium text-ink-900">
                        <Icon className="size-4 shrink-0 text-brand-700" aria-hidden />
                        {FUNDRAISER_KIND_LABELS[option]}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-500">{FUNDRAISER_KIND_HINTS[option]}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <FieldError id="kind-error">{errors.kind}</FieldError>
          </fieldset>

          <Field label="Status" htmlFor="status" error={errors.status} className="sm:max-w-64">
            <Select {...control("status")}>
              {FUNDRAISER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {FUNDRAISER_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Details" htmlFor="description" error={errors.description} optional hint="What it is, what to bring, how it works.">
            <Textarea {...control("description")} rows={4} maxLength={LIMITS.fundraiserDescriptionMax} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="When and where" description="Leave the end date empty for a one-day fundraiser." />
        <CardBody className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Starts" htmlFor="startsOn" error={errors.startsOn} optional>
              <Input {...control("startsOn")} type="date" min={minDate} max={maxDate} className="sm:max-w-48" />
            </Field>
            <Field label="Ends" htmlFor="endsOn" error={errors.endsOn} optional>
              <Input {...control("endsOn")} type="date" min={minDate} max={maxDate} className="sm:max-w-48" />
            </Field>
          </div>
          <Field label="Location" htmlFor="location" error={errors.location} optional>
            <Input {...control("location")} maxLength={LIMITS.fundraiserLocationMax} placeholder="e.g. School parking lot, or Online" autoComplete="off" />
          </Field>
          <Field label="Link" htmlFor="link" error={errors.link} optional hint="Donation page, sign-up sheet, or flyer.">
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
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Money" description="Whole dollars." />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Field label="Goal ($)" htmlFor="goalAmount" error={errors.goalAmount} optional>
            <Input {...control("goalAmount")} inputMode="decimal" autoComplete="off" placeholder="e.g. 500" className="sm:max-w-48" />
          </Field>
          <Field label="Raised so far ($)" htmlFor="raisedAmount" error={errors.raisedAmount} optional>
            <Input {...control("raisedAmount")} inputMode="decimal" autoComplete="off" placeholder="0" className="sm:max-w-48" />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="People" />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Field label="Who's leading it" htmlFor="leadId" error={errors.leadId} optional>
            <Select {...control("leadId")}>
              <option value="">No one yet</option>
              {currentLead && <option value={currentLead.id}>{currentLead.name} (no longer on the team)</option>}
              {leadGroups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field
            label="Helper spots"
            htmlFor="volunteerLimit"
            error={errors.volunteerLimit}
            optional
            hint="Most people it needs. Leave it empty for no limit."
          >
            <Input
              {...control("volunteerLimit")}
              // Text, not type="number": whatever was typed reaches the server, which explains a bad value.
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              className="max-w-32"
            />
          </Field>
        </CardBody>
      </Card>
    </>
  );
}
