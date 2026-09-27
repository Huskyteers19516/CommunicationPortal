"use client";

import { useActionState, useRef } from "react";
import type { PartProcess } from "@/generated/prisma/enums";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, FieldError, Input, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS, PART_PROCESS_LABELS, PART_PROCESSES } from "@/lib/constants";
import type { CategoryGroup } from "@/server/queries/parts";
import { PART_PROCESS_ICONS } from "./part-badges";

export interface PartFormInitial {
  id?: string;
  name: string;
  process: PartProcess;
  quantity: string;
  material: string;
  fileUrl: string;
  notes: string;
  /** "For": a category's name or anything typed in ("" = nothing specific). */
  forText: string;
  neededBy: string;
}

const PROCESS_HINTS: Record<PartProcess, string> = {
  PRINT_3D: "PLA, PETG, TPU…",
  LASER_CUT: "Plastic or wood sheet",
  CNC: "Router or mill",
  CUT: "Saw, shear, by hand",
  MACHINE: "Lathe, mill, drill press",
  OTHER: "Anything else",
};

/**
 * Add / edit a part. Values survive validation errors (the fields remount with what was sent) and
 * focus goes to the first field to fix. The server checks everything and explains problems inline
 * (`noValidate`: no browser bubbles), and adds https:// to a bare link like drive.google.com/…
 */
export function PartForm({
  action,
  initial,
  categoryGroups,
  submitLabel,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: PartFormInitial;
  categoryGroups: CategoryGroup[];
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);

  return (
    <form ref={formRef} action={formAction} className="space-y-6" noValidate>
      <FormMessage state={state} />
      {initial.id && <input type="hidden" name="partId" value={initial.id} />}
      <Card>
        <PartFields key={state?.nonce ?? 0} state={state} initial={initial} categoryGroups={categoryGroups} />
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href="/parts" variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function PartFields({
  state,
  initial,
  categoryGroups,
}: {
  state: ActionState;
  initial: PartFormInitial;
  categoryGroups: CategoryGroup[];
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: keyof PartFormInitial) => v?.[key] ?? initial[key] ?? "";
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);
  const process = value("process");
  // Suggestions for "For": every category name once (Build's first, as the groups come in).
  const suggestions = [...new Set(categoryGroups.flatMap((g) => g.options.map((o) => o.name)))];

  return (
    <CardBody className="space-y-5">
      <Field label="Part name" htmlFor="name" error={errors.name}>
        <Input
          id="name"
          name="name"
          required
          maxLength={LIMITS.partNameMax}
          defaultValue={value("name")}
          invalid={!!errors.name}
          aria-describedby={described("name")}
          placeholder="e.g. Intake side plate"
          autoComplete="off"
        />
      </Field>

      <fieldset aria-describedby={described("process")}>
        <legend className="text-sm font-medium text-ink-800">How it&apos;s made</legend>
        <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PART_PROCESSES.map((option, i) => {
            const Icon = PART_PROCESS_ICONS[option];
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
                  name="process"
                  value={option}
                  defaultChecked={process === option}
                  required
                  // Radios can't take aria-invalid; this marks where focus goes after a "process" error.
                  data-invalid={errors.process && i === 0 ? "true" : undefined}
                  className="mt-0.5 size-4 shrink-0 accent-brand-600"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-medium text-ink-900">
                    <Icon className="size-4 shrink-0 text-brand-700" aria-hidden />
                    {PART_PROCESS_LABELS[option]}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-500">{PROCESS_HINTS[option]}</span>
                </span>
              </label>
            );
          })}
        </div>
        <FieldError id="process-error">{errors.process}</FieldError>
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Quantity" htmlFor="quantity" error={errors.quantity} hint="How many to make.">
          <Input
            id="quantity"
            name="quantity"
            // Text, not type="number": whatever was typed reaches the server, which explains a bad
            // value, instead of the browser quietly sending "" for it.
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            required
            defaultValue={value("quantity")}
            invalid={!!errors.quantity}
            aria-describedby={described("quantity")}
            className="max-w-32"
          />
        </Field>
        <Field label="Material" htmlFor="material" error={errors.material} optional>
          <Input
            id="material"
            name="material"
            maxLength={LIMITS.partMaterialMax}
            defaultValue={value("material")}
            invalid={!!errors.material}
            aria-describedby={described("material")}
            placeholder="e.g. PLA, 1/8 in aluminum"
          />
        </Field>
      </div>

      <Field
        label="File link"
        htmlFor="fileUrl"
        error={errors.fileUrl}
        optional
        hint="A link to the CAD, STL, or drawing."
      >
        <Input
          id="fileUrl"
          name="fileUrl"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={LIMITS.resourceUrlMax}
          defaultValue={value("fileUrl")}
          invalid={!!errors.fileUrl}
          aria-describedby={described("fileUrl")}
          placeholder="https://"
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="For"
          htmlFor="forText"
          error={errors.forText ?? errors.categoryId}
          optional
          hint="What it's for, like Intake or Drivetrain. Pick a suggestion or type your own."
        >
          <Input
            id="forText"
            name="forText"
            list={suggestions.length ? "part-for-suggestions" : undefined}
            maxLength={LIMITS.partForMax}
            autoComplete="off"
            defaultValue={value("forText")}
            invalid={!!(errors.forText ?? errors.categoryId)}
            aria-describedby={described(errors.forText ? "forText" : "categoryId")}
            placeholder="e.g. Intake"
          />
        </Field>
        {suggestions.length > 0 && (
          <datalist id="part-for-suggestions">
            {suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
        <Field label="Needed by" htmlFor="neededBy" error={errors.neededBy} optional>
          <Input
            id="neededBy"
            name="neededBy"
            type="date"
            defaultValue={value("neededBy")}
            invalid={!!errors.neededBy}
            aria-describedby={described("neededBy")}
            className="max-w-48"
          />
        </Field>
      </div>

      <Field label="Notes" htmlFor="notes" error={errors.notes} optional>
        <Textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={LIMITS.partNotesMax}
          defaultValue={value("notes")}
          invalid={!!errors.notes}
          aria-describedby={described("notes")}
          placeholder="Infill, tolerances, how many spares…"
        />
      </Field>
    </CardBody>
  );
}
