"use client";

import { Globe } from "lucide-react";
import { type ReactNode, useActionState, useRef } from "react";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { LIMITS, SPONSORSHIP_STAGE_LABELS, SPONSORSHIP_STAGES } from "@/lib/constants";
import { TEAM_SITE_ORIGIN } from "@/lib/public-progress";
import type { OwnerOption } from "@/lib/sponsorships";

export interface SponsorshipFormValues {
  id?: string;
  /** Editing: the sponsor's updatedAt when the page loaded (ISO), so saving can't undo someone else's change. */
  version?: string;
  name: string;
  website: string;
  contactName: string;
  contactEmail: string;
  asking: string;
  /** Whole dollars as text ("" = nothing yet). */
  amountReceived: string;
  stage: SponsorshipStage;
  /** "" = no one yet. */
  ownerId: string;
  /** "YYYY-MM-DD" or "". */
  submittedOn: string;
  acceptedOn: string;
  closesOn: string;
  notes: string;
  /** "Thank them on the team website". */
  showOnWebsite: boolean;
  /** "Name on the website" ("" = the sponsor's name). */
  publicName: string;
}

export interface OwnerChoices {
  business: OwnerOption[];
  staff: OwnerOption[];
  /** Editing: the current person when they can't be picked any more (they left, or changed subteams). */
  current?: OwnerOption | null;
}

/**
 * Add / edit a sponsor. Values survive errors (fields remount with the submitted values). Saving goes to
 * the list, which highlights the sponsor; problems show next to the Save button (and focus the first bad field).
 */
export function SponsorshipForm({
  action,
  initial,
  owners,
  submitLabel,
  logoField,
  websiteOff = false,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: SponsorshipFormValues;
  owners: OwnerChoices;
  submitLabel: string;
  /** Editing: the logo picker for the "Team website" section (it saves on its own, right away). */
  logoField?: ReactNode;
  /** The team website's Sponsors page is turned off right now (Admin → Approvals → Team website): the section says so. */
  websiteOff?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);

  return (
    <form ref={formRef} action={formAction} className="space-y-5">
      {initial.id && <input type="hidden" name="sponsorshipId" value={initial.id} />}
      {initial.version && <input type="hidden" name="version" value={initial.version} />}
      {/* This form has the "Team website" section, so its checkbox and name are saved (the import has neither). */}
      <input type="hidden" name="websiteFields" value="1" />
      <SponsorshipFields key={state?.nonce ?? 0} state={state} initial={initial} owners={owners} logoField={logoField} websiteOff={websiteOff} />
      {/* Next to the button people just pressed (the form is long on phones). Success goes to the list. */}
      <FormMessage state={state && !state.ok ? state : null} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href="/sponsors" variant="secondary">
          {initial.id ? "Back to Sponsorships" : "Cancel"}
        </ButtonLink>
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function SponsorshipFields({
  state,
  initial,
  owners,
  logoField,
  websiteOff,
}: {
  state: ActionState;
  initial: SponsorshipFormValues;
  owners: OwnerChoices;
  logoField?: ReactNode;
  websiteOff: boolean;
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: keyof SponsorshipFormValues) => v?.[key] ?? String(initial[key] ?? "");
  /** Props every text control shares: name, error state, and the error's id for screen readers. */
  const control = (key: keyof SponsorshipFormValues) => ({
    id: key,
    name: key,
    invalid: !!errors[key],
    "aria-describedby": errors[key] ? `${key}-error` : undefined,
    defaultValue: value(key),
  });

  return (
    <>
      <Card>
        <CardHeader title="Sponsor" description="Who we're asking, and how to reach them." />
        <CardBody className="space-y-5">
          <Field label="Name" htmlFor="name" error={errors.name}>
            <Input {...control("name")} required maxLength={LIMITS.sponsorNameMax} placeholder="e.g. Polymaker" autoComplete="off" />
          </Field>
          <Field
            label="Website"
            htmlFor="website"
            error={errors.website}
            optional
            hint="Their site or the application page. The team website only ever links to its homepage (e.g. https://rev.example.com/), never the rest of the address."
          >
            <Input {...control("website")} inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Contact name" htmlFor="contactName" error={errors.contactName} optional>
              <Input {...control("contactName")} maxLength={LIMITS.nameMax} autoComplete="off" placeholder="Who we talk to there" />
            </Field>
            <Field label="Contact email" htmlFor="contactEmail" error={errors.contactEmail} optional>
              <Input {...control("contactEmail")} type="email" inputMode="email" autoComplete="off" spellCheck={false} maxLength={LIMITS.emailMax} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="The ask" />
        <CardBody className="space-y-5">
          <Field label="What we're asking for" htmlFor="asking" error={errors.asking} optional>
            <Input {...control("asking")} maxLength={LIMITS.sponsorAskingMax} placeholder="e.g. $1,000 or 10 spools of filament" />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Stage" htmlFor="stage" error={errors.stage}>
              <Select {...control("stage")}>
                {SPONSORSHIP_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {SPONSORSHIP_STAGE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Person" htmlFor="ownerId" error={errors.ownerId} optional hint="Who on the team is handling it.">
              <Select {...control("ownerId")}>
                <option value="">No one yet</option>
                {owners.current && <option value={owners.current.id}>{owners.current.name} (no longer on the list)</option>}
                {owners.business.length > 0 && (
                  <optgroup label="Business">
                    {owners.business.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {owners.staff.length > 0 && (
                  <optgroup label="Leaders and mentors">
                    {owners.staff.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </Field>
          </div>
          <Field label="Amount received ($)" htmlFor="amountReceived" error={errors.amountReceived} optional hint="Whole dollars. Leave it empty until money comes in.">
            <Input {...control("amountReceived")} inputMode="decimal" autoComplete="off" placeholder="e.g. 500" className="sm:max-w-48" />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Dates" description="Changing the stage to Submitted or Accepted fills in today's date if it's empty." />
        <CardBody className="grid gap-5 sm:grid-cols-3">
          <Field label="Submitted" htmlFor="submittedOn" error={errors.submittedOn} optional>
            <Input {...control("submittedOn")} type="date" />
          </Field>
          <Field label="Accepted" htmlFor="acceptedOn" error={errors.acceptedOn} optional>
            <Input {...control("acceptedOn")} type="date" />
          </Field>
          <Field label="Closes" htmlFor="closesOn" error={errors.closesOn} optional hint="The application deadline.">
            <Input {...control("closesOn")} type="date" />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Team website"
          description={`Accepted and finished sponsors are thanked on the team's site (${TEAM_SITE_ORIGIN.replace("https://", "")}/sponsors) with their name, logo, website's homepage, and years — never amounts, contacts, or notes.`}
        />
        <CardBody className="space-y-5">
          {websiteOff && (
            <p className="flex items-start gap-2 text-sm text-ink-500">
              <Globe className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0">
                The Sponsors page is turned off on the team website right now (Admin → Approvals → Team website): nothing here is
                shown until it&apos;s turned on.
              </span>
            </p>
          )}
          <CheckboxField
            name="showOnWebsite"
            defaultChecked={v ? v.showOnWebsite === "on" : initial.showOnWebsite}
            label="Thank them on the team website"
            description="Once they're Accepted or Finished. Turn it off for donors who'd rather not be named."
          />
          <Field
            label="Name on the website"
            htmlFor="publicName"
            error={errors.publicName}
            optional
            hint="Leave it empty to use the sponsor's name. Sponsors with the same name are shown once, with all their years."
          >
            <Input {...control("publicName")} maxLength={LIMITS.sponsorNameMax} autoComplete="off" placeholder="e.g. The Home Depot" />
          </Field>
          {logoField ?? (
            <p className="text-sm text-ink-500">You can add their brand logo once the sponsor is saved (on its page).</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <Field label="Notes" htmlFor="notes" error={errors.notes} optional>
            <Textarea {...control("notes")} rows={5} maxLength={LIMITS.sponsorNotesMax} placeholder="What they said, what to send next, links…" />
          </Field>
        </CardBody>
      </Card>
    </>
  );
}
