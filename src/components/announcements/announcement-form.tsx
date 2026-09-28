"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { AnnouncementFormState } from "@/app/(app)/announcements/actions";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { CheckboxField, Field, FieldError, Input, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { Subteam } from "@/generated/prisma/enums";
import type { ActionState } from "@/lib/action-state";
import {
  type AnnouncementAudienceValue,
  type AnnouncementFormValues,
  audienceValue,
  mergeAnnouncementEdits,
  submittedAnnouncementValues,
} from "@/lib/announcements";
import { cn } from "@/lib/cn";
import { LIMITS, SUBTEAM_LABELS } from "@/lib/constants";

const AUDIENCE_HINTS: Record<AnnouncementAudienceValue, string> = {
  team: "New for everyone",
  SOFTWARE: "New for Software only",
  BUILD: "New for Build only",
  BUSINESS: "New for Business only",
};

function audienceName(value: AnnouncementAudienceValue): string {
  return value === "team" ? "Whole team" : SUBTEAM_LABELS[value];
}

/**
 * Post / edit an announcement. Values survive validation errors (the fields remount with what was sent), focus goes
 * to the first field to fix — or to the message when it isn't about one field (e.g. someone else changed it
 * meanwhile) — and the server explains problems inline (`noValidate`).
 *
 * Editing: the form sends back the `version` it loaded. A refresh of the page (e.g. after a Remove that was refused)
 * doesn't change it, so a save over someone else's change always hears about it. Then the form shows the newest
 * values with the person's own edits on top, and the newest version (saving again goes through).
 */
export function AnnouncementForm({
  action,
  initial,
  audiences,
  submitLabel,
  pendingText = "Saving…",
  cancelHref = "/announcements",
}: {
  action: (prev: AnnouncementFormState, formData: FormData) => Promise<AnnouncementFormState>;
  initial: AnnouncementFormValues;
  /** Who it can be for (null = the whole team). */
  audiences: (Subteam | null)[];
  submitLabel: string;
  /** The button's words while it's sending ("Posting…"). */
  pendingText?: string;
  /** Where "Cancel" goes (editing: back to the announcement on the list). */
  cancelHref?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  useFocusFirstError(state, formRef);
  useEffect(() => {
    if (state && !state.ok && Object.keys(state.fieldErrors ?? {}).length === 0) messageRef.current?.focus();
  }, [state]);

  // What the fields were loaded from (its `version` is sent), and what they show after someone else's change.
  const [loaded, setLoaded] = useState(initial);
  const [merged, setMerged] = useState<AnnouncementFormValues | null>(null);
  const [handled, setHandled] = useState(state);
  if (state !== handled) {
    setHandled(state);
    const latest = state?.latest;
    setMerged(latest && state.values ? mergeAnnouncementEdits(loaded, submittedAnnouncementValues(state.values), latest) : null);
    if (latest) setLoaded(latest);
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-5" noValidate>
      {loaded.id && <input type="hidden" name="announcementId" value={loaded.id} />}
      {loaded.version && <input type="hidden" name="version" value={loaded.version} />}
      <Card>
        <AnnouncementFields
          key={state?.nonce ?? 0}
          state={state}
          initial={merged ?? loaded}
          showSubmitted={!merged}
          audiences={audiences.map(audienceValue)}
        />
      </Card>
      {/* Next to the button people just pressed (the form is long on phones). Success goes to the list. */}
      {state && !state.ok && state.message && (
        <div ref={messageRef} tabIndex={-1} className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40">
          <FormMessage state={state} />
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText={pendingText}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function AnnouncementFields({
  state,
  initial,
  showSubmitted,
  audiences,
}: {
  state: ActionState;
  initial: AnnouncementFormValues;
  /** After a failed save: show what was sent (not after someone else's change: `initial` has the merged values). */
  showSubmitted: boolean;
  audiences: AnnouncementAudienceValue[];
}) {
  const v = showSubmitted ? state?.values : undefined;
  const errors = state?.fieldErrors ?? {};
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);
  const title = v?.title ?? initial.title;
  const body = v?.body ?? initial.body;
  const audience = (v?.audience as AnnouncementAudienceValue | undefined) ?? initial.audience;
  // An unticked checkbox isn't sent: after a failed save, "not in the values" means it was unticked.
  const pinned = v ? v.pinned === "on" : initial.pinned;
  const only = audiences.length === 1 ? audiences[0] : null;

  return (
    <CardBody className="space-y-5">
      <Field label="Title" htmlFor="title" error={errors.title}>
        <Input
          id="title"
          name="title"
          required
          maxLength={LIMITS.announcementTitleMax}
          defaultValue={title}
          invalid={!!errors.title}
          aria-describedby={described("title")}
          placeholder="e.g. No meeting on Thursday"
          autoComplete="off"
        />
      </Field>

      <Field label="Message" htmlFor="body" error={errors.body} hint="Line breaks and links work.">
        <Textarea
          id="body"
          name="body"
          rows={7}
          required
          maxLength={LIMITS.announcementBodyMax}
          defaultValue={body}
          invalid={!!errors.body}
          aria-describedby={described("body")}
          placeholder="What does the team need to know?"
        />
      </Field>

      {only ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-ink-800">For</p>
          <p className="text-sm text-ink-700">{audienceName(only)}</p>
          <input type="hidden" name="audience" value={only} />
          <FieldError id="audience-error">{errors.audience}</FieldError>
        </div>
      ) : (
        <fieldset aria-describedby={cn("audience-hint", described("audience"))}>
          <legend className="text-sm font-medium text-ink-800">For</legend>
          <p id="audience-hint" className="mt-0.5 text-xs text-ink-500">
            Everyone can read it. Only the people you pick get it as new (menu badge and Today).
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {audiences.map((option, i) => (
              <label
                key={option}
                className={cn(
                  "flex min-h-12 cursor-pointer items-start gap-2.5 rounded-lg border bg-white p-3 text-sm shadow-sm transition-colors hover:border-brand-300",
                  // Red like the other fields when nobody was picked.
                  errors.audience ? "border-red-400" : "border-ink-200",
                  "has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50 has-[:checked]:ring-1 has-[:checked]:ring-brand-500",
                  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40",
                )}
              >
                <input
                  type="radio"
                  name="audience"
                  value={option}
                  defaultChecked={audience === option}
                  required
                  // Radios can't take aria-invalid; this marks where focus goes after an "audience" error.
                  data-invalid={errors.audience && i === 0 ? "true" : undefined}
                  className="mt-0.5 size-4 shrink-0 accent-brand-600"
                />
                <span className="min-w-0">
                  <span className="block font-medium text-ink-900">{audienceName(option)}</span>
                  <span className="mt-0.5 block text-xs text-ink-500">{AUDIENCE_HINTS[option]}</span>
                </span>
              </label>
            ))}
          </div>
          <FieldError id="audience-error">{errors.audience}</FieldError>
        </fieldset>
      )}

      <CheckboxField
        name="pinned"
        label="Pin to the top"
        description="Pinned announcements stay above the others until someone unpins them."
        defaultChecked={pinned}
      />
    </CardBody>
  );
}
