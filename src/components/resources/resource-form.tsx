"use client";

import { FileUp, Link2, type LucideIcon } from "lucide-react";
import { type ChangeEvent, useActionState, useRef, useState } from "react";
import type { ResourceType } from "@/generated/prisma/enums";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { CheckboxField, Field, FieldError, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS, RESOURCE_TYPE_LABELS, RESOURCE_TYPES } from "@/lib/constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "@/lib/files";

type Kind = "link" | "file";

export interface ResourceFormValues {
  id?: string;
  kind: Kind;
  title: string;
  url: string;
  description: string;
  type: ResourceType;
  group: string;
  pinned: boolean;
  linksText: string;
  /** Editing a file resource: the file it has now (kept unless a new one is chosen). */
  currentFile?: { filename: string; size: number } | null;
}

const KIND_OPTIONS: Array<{ value: Kind; label: string; hint: string; icon: LucideIcon }> = [
  { value: "link", label: "Link", hint: "Docs, GitHub, Onshape…", icon: Link2 },
  { value: "file", label: "File", hint: `Code, PDFs, images (up to ${RESOURCE_FILE_MAX_MB} MB)`, icon: FileUp },
];

/**
 * Add / edit a resource: a link or an uploaded file. Values survive validation errors (fields
 * remount on each result), except the file itself: browsers can't refill a file input, so the
 * form asks for it again.
 */
export function ResourceForm({
  action,
  initial,
  groups,
  submitLabel,
  canPin,
  needsApproval,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: ResourceFormValues;
  groups: string[];
  submitLabel: string;
  /** People with admin access can pin. */
  canPin: boolean;
  /** Members: it waits for a leader or admin before the team sees it. */
  needsApproval: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  // After a failed save, take people to the field to fix (the message at the top may be far from it).
  useFocusFirstError(state, formRef);

  return (
    <form ref={formRef} action={formAction} className="space-y-6">
      <FormMessage state={state} />
      {needsApproval && (
        <Alert tone="info" title="A leader or admin approves it first">
          Until then only you and they can see it. You can still edit or remove it.
        </Alert>
      )}
      {initial.id && <input type="hidden" name="resourceId" value={initial.id} />}
      <Card>
        <ResourceFields key={state?.nonce ?? 0} state={state} initial={initial} groups={groups} canPin={canPin} />
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={initial.id ? `/resources/${initial.id}` : "/resources"} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function ResourceFields({
  state,
  initial,
  groups,
  canPin,
}: {
  state: ActionState;
  initial: ResourceFormValues;
  groups: string[];
  canPin: boolean;
}) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: keyof ResourceFormValues, fallback: string) => v?.[key] ?? fallback;
  const [kind, setKind] = useState<Kind>(v?.kind === "file" || v?.kind === "link" ? v.kind : initial.kind);
  const [tooBig, setTooBig] = useState<string | null>(null);
  // The browser dropped the chosen file when the form came back with an error.
  const pickAgain = !!state && !state.ok && v?.kind === "file";
  const hasCurrentFile = kind === "file" && initial.kind === "file" && !!initial.currentFile;
  const fileError = errors.file ?? tooBig ?? undefined;

  function checkSize(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    const message =
      file && file.size > LIMITS.resourceFileMaxBytes
        ? `That file is ${formatFileSize(file.size)}. Files can be up to ${RESOURCE_FILE_MAX_MB} MB, so share a link instead.`
        : null;
    // Blocks the submit (and says why) before a big upload is sent at all.
    input.setCustomValidity(message ?? "");
    setTooBig(message);
  }

  return (
    <CardBody className="space-y-5">
      <fieldset aria-describedby={errors.kind ? "kind-error" : undefined}>
        <legend className="text-sm font-medium text-ink-800">What are you sharing?</legend>
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          {KIND_OPTIONS.map(({ value: option, label, hint, icon: Icon }, i) => (
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
                checked={kind === option}
                onChange={() => setKind(option)}
                // Radios can't take aria-invalid; this marks where focus goes after a "kind" error.
                data-invalid={errors.kind && i === 0 ? "true" : undefined}
                className="mt-0.5 size-4 shrink-0 accent-brand-600"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium text-ink-900">
                  <Icon className="size-4 shrink-0 text-brand-700" aria-hidden />
                  {label}
                </span>
                <span className="mt-0.5 block text-xs text-ink-500">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <FieldError id="kind-error">{errors.kind}</FieldError>
      </fieldset>

      <Field label="Title" htmlFor="title" error={errors.title}>
        <Input id="title" name="title" invalid={!!errors.title} aria-describedby={errors.title ? "title-error" : undefined} required maxLength={LIMITS.resourceTitleMax} defaultValue={value("title", initial.title)} placeholder={kind === "file" ? "e.g. TeleOp starter code" : "e.g. Huskyteers Team Docs"} />
      </Field>

      <div hidden={kind !== "link"}>
        <Field label="Link" htmlFor="url" error={errors.url} hint="The full address, starting with https://">
          <Input id="url" name="url" invalid={!!errors.url} aria-describedby={errors.url ? "url-error" : undefined} type="url" inputMode="url" required={kind === "link"} disabled={kind !== "link"} maxLength={LIMITS.resourceUrlMax} defaultValue={value("url", initial.url)} placeholder="https://" />
        </Field>
      </div>

      <div hidden={kind !== "file"} className="space-y-2">
        <Field
          label="File"
          htmlFor="file"
          error={fileError}
          hint={`Up to ${RESOURCE_FILE_MAX_MB} MB. Code, PDFs, images… For bigger files (CAD), share a link.`}
        >
          <input
            id="file"
            name="file"
            type="file"
            required={kind === "file" && !hasCurrentFile}
            disabled={kind !== "file"}
            onChange={checkSize}
            aria-invalid={fileError ? true : undefined}
            aria-describedby={fileError ? "file-error" : undefined}
            className={cn(
              "block w-full min-w-0 rounded-lg border bg-white p-1.5 text-sm text-ink-700 shadow-sm",
              "file:mr-3 file:h-10 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-50 file:px-4 file:text-sm file:font-medium file:text-brand-800 hover:file:bg-brand-100",
              fileError ? "border-red-400" : "border-ink-200",
            )}
          />
        </Field>
        {hasCurrentFile && initial.currentFile && (
          <p className="text-sm text-ink-600">
            Current file: <span className="font-mono font-medium text-ink-900 wrap-anywhere">{initial.currentFile.filename}</span> (
            {formatFileSize(initial.currentFile.size)}). Choose a new file to replace it.
          </p>
        )}
        {pickAgain && (
          <p role="status" className="text-sm font-medium text-amber-800">
            {hasCurrentFile ? "If you picked a new file, choose it again." : "Please choose the file again."} Files aren&apos;t
            kept when the form has an error.
          </p>
        )}
      </div>

      <Field label="Description" htmlFor="description" error={errors.description} optional>
        <Textarea id="description" name="description" invalid={!!errors.description} aria-describedby={errors.description ? "description-error" : undefined} rows={2} maxLength={LIMITS.resourceDescriptionMax} defaultValue={value("description", initial.description)} placeholder="What it's for, who uses it." />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Type" htmlFor="type" error={errors.type}>
          <Select id="type" name="type" invalid={!!errors.type} aria-describedby={errors.type ? "type-error" : undefined} defaultValue={value("type", initial.type)}>
            {RESOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {RESOURCE_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Section" htmlFor="group" error={errors.group} optional hint="Resources are grouped under this heading.">
          <Input id="group" name="group" invalid={!!errors.group} aria-describedby={errors.group ? "group-error" : undefined} list="resource-groups" maxLength={LIMITS.resourceGroupMax} defaultValue={value("group", initial.group)} placeholder="e.g. Team Docs" />
        </Field>
        <datalist id="resource-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </div>
      <Field
        label="Quick links"
        htmlFor="links"
        error={errors.links}
        optional
        hint="Shown as buttons on the card. One per line: Label | https://…"
      >
        <Textarea
          id="links"
          name="links"
          invalid={!!errors.links}
          aria-describedby={errors.links ? "links-error" : undefined}
          rows={4}
          className="font-mono text-xs sm:text-sm"
          defaultValue={v?.links ?? initial.linksText}
          placeholder={"Meeting Agenda | https://…\nImportant Dates | https://…"}
        />
      </Field>
      {canPin && (
        <CheckboxField
          name="pinned"
          label="Pin to the top"
          description="Pinned resources are shown first."
          defaultChecked={v ? v.pinned === "on" : initial.pinned}
        />
      )}
    </CardBody>
  );
}
