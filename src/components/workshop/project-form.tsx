"use client";

import { useActionState, useRef, useState } from "react";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, FieldError, Input, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import {
  WORKSHOP_KIND_HINTS,
  WORKSHOP_KIND_LABELS,
  WORKSHOP_KINDS,
  WORKSHOP_LIMITS,
  WORKSHOP_MATERIAL_SUGGESTIONS,
  type WorkshopKindValue,
} from "@/lib/workshop";
import type { WorkshopPerson } from "@/server/queries/workshop";
import { CreditsPicker } from "./credits-picker";
import { WORKSHOP_FIELD_LABELS, WORKSHOP_KIND_ICONS } from "./kinds";

export interface WorkshopProjectFormValues {
  id?: string;
  kind: WorkshopKindValue;
  title: string;
  summary: string;
  material: string;
  season: string;
  extraCredits: string;
  link: string;
  codeLink: string;
  /** Credited people, in order (editing: may include people who have left the team since). */
  credits: WorkshopPerson[];
}

type TextKey = "title" | "summary" | "material" | "season" | "extraCredits" | "link";

/**
 * Add / edit a Workshop project's details. The kind picks what the fields are called (a part's "Material" is a
 * program's "Built with"). The kind, the credits, and the source code link live in this component's state, so they
 * survive a save that comes back with an error (a failed save doesn't send back fields named like "code"); the other
 * text fields remount with what was sent. The server checks everything again (`noValidate`: no browser bubbles), and
 * focus goes to the first field to fix.
 */
export function WorkshopProjectForm({
  action,
  initial,
  people,
  submitLabel,
  cancelHref,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: WorkshopProjectFormValues;
  /** Everyone who can be credited (ACTIVE accounts). */
  people: WorkshopPerson[];
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [kind, setKind] = useState<WorkshopKindValue>(initial.kind);
  const [creditIds, setCreditIds] = useState<string[]>(() => initial.credits.map((c) => c.id));
  const [codeLink, setCodeLink] = useState(initial.codeLink);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);

  // People credited before who have left the team stay listed (and credited) unless they're unpicked.
  const listed = new Set(people.map((p) => p.id));
  const everyone = [...people, ...initial.credits.filter((c) => !listed.has(c.id))];
  const errors = state?.fieldErrors ?? {};

  return (
    <form ref={formRef} action={formAction} className="space-y-6" noValidate>
      <FormMessage state={state} />
      {initial.id && <input type="hidden" name="projectId" value={initial.id} />}
      <Card>
        <CardBody className="space-y-5">
          <KindPicker kind={kind} onChange={setKind} error={errors.kind} />
          <ProjectFields
            key={state?.nonce ?? 0}
            state={state}
            initial={initial}
            kind={kind}
            codeLink={codeLink}
            onCodeLinkChange={setCodeLink}
          />
        </CardBody>
      </Card>
      <Card>
        <CardBody className="space-y-5">
          <CreditsPicker people={everyone} selected={creditIds} onChange={setCreditIds} error={errors.creditIds} />
          <ExtraCreditsField key={state?.nonce ?? 0} state={state} initial={initial} />
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

function KindPicker({ kind, onChange, error }: { kind: WorkshopKindValue; onChange: (kind: WorkshopKindValue) => void; error?: string }) {
  return (
    <fieldset aria-describedby={error ? "kind-error" : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-ink-800">What kind of project?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {WORKSHOP_KINDS.map((k) => {
          const Icon = WORKSHOP_KIND_ICONS[k];
          const checked = kind === k;
          return (
            <label
              key={k}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40",
                checked ? "border-brand-500 bg-brand-50" : "border-ink-200 bg-white hover:bg-ink-50",
              )}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={checked}
                onChange={() => onChange(k)}
                data-invalid={error ? true : undefined}
                className="mt-0.5 size-4 shrink-0 accent-brand-600"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
                  <Icon className="size-4 shrink-0 text-brand-700" aria-hidden />
                  {WORKSHOP_KIND_LABELS[k]}
                </span>
                <span className="mt-0.5 block text-xs text-ink-500">{WORKSHOP_KIND_HINTS[k]}</span>
              </span>
            </label>
          );
        })}
      </div>
      <FieldError id="kind-error">{error}</FieldError>
    </fieldset>
  );
}

function ProjectFields({
  state,
  initial,
  kind,
  codeLink,
  onCodeLinkChange,
}: {
  state: ActionState;
  initial: WorkshopProjectFormValues;
  kind: WorkshopKindValue;
  codeLink: string;
  onCodeLinkChange: (codeLink: string) => void;
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: TextKey) => v?.[key] ?? initial[key];
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);
  const labels = WORKSHOP_FIELD_LABELS[kind];

  return (
    <div className="space-y-5">
      <Field label="Name" htmlFor="title" error={errors.title}>
        <Input
          id="title"
          name="title"
          required
          maxLength={WORKSHOP_LIMITS.titleMax}
          defaultValue={value("title")}
          invalid={!!errors.title}
          aria-describedby={described("title")}
          placeholder={labels.titlePlaceholder}
          autoComplete="off"
        />
      </Field>

      <Field label={labels.summary} htmlFor="summary" error={errors.summary}>
        <Textarea
          id="summary"
          name="summary"
          rows={4}
          required
          maxLength={WORKSHOP_LIMITS.summaryMax}
          defaultValue={value("summary")}
          invalid={!!errors.summary}
          aria-describedby={described("summary")}
          placeholder={labels.summaryPlaceholder}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={labels.material} htmlFor="material" error={errors.material} optional>
          <Input
            id="material"
            name="material"
            maxLength={WORKSHOP_LIMITS.materialMax}
            defaultValue={value("material")}
            invalid={!!errors.material}
            aria-describedby={described("material")}
            placeholder={labels.materialPlaceholder}
            list={kind === "PART" ? "workshop-materials" : undefined}
            autoComplete="off"
          />
        </Field>
        <Field label="Season" htmlFor="season" error={errors.season} optional>
          <Input
            id="season"
            name="season"
            maxLength={WORKSHOP_LIMITS.seasonMax}
            defaultValue={value("season")}
            invalid={!!errors.season}
            aria-describedby={described("season")}
            placeholder="2025–26"
            autoComplete="off"
          />
        </Field>
      </div>
      <datalist id="workshop-materials">
        {WORKSHOP_MATERIAL_SUGGESTIONS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <Field label={labels.link} htmlFor="link" error={errors.link} optional hint={labels.linkHint}>
        <Input
          id="link"
          name="link"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={WORKSHOP_LIMITS.linkMax}
          defaultValue={value("link")}
          invalid={!!errors.link}
          aria-describedby={described("link")}
          placeholder="https://"
        />
      </Field>

      {/* Parts have no source code: not shown or sent (the server clears it). One typed before switching to a part
          comes back when switching away again. */}
      {kind !== "PART" && (
        <Field label="Source code link" htmlFor="codeLink" error={errors.codeLink} optional hint="GitHub or wherever the code lives.">
          <Input
            id="codeLink"
            name="codeLink"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={WORKSHOP_LIMITS.linkMax}
            value={codeLink}
            onChange={(e) => onCodeLinkChange(e.target.value)}
            invalid={!!errors.codeLink}
            aria-describedby={described("codeLink")}
            placeholder="https://github.com/…"
          />
        </Field>
      )}
    </div>
  );
}

function ExtraCreditsField({ state, initial }: { state: ActionState; initial: WorkshopProjectFormValues }) {
  const errors = state?.fieldErrors ?? {};
  return (
    <Field
      label="Other people (no portal account)"
      htmlFor="extraCredits"
      error={errors.extraCredits}
      optional
      hint="Comma-separated, e.g. alumni."
    >
      <Input
        id="extraCredits"
        name="extraCredits"
        maxLength={WORKSHOP_LIMITS.extraCreditsMax}
        defaultValue={state?.values?.extraCredits ?? initial.extraCredits}
        invalid={!!errors.extraCredits}
        aria-describedby={errors.extraCredits ? "extraCredits-error" : undefined}
        placeholder="e.g. Alex Kim, Jordan Lee"
        autoComplete="off"
      />
    </Field>
  );
}
