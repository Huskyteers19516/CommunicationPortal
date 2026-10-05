"use client";

import { FilePlus2, Trash2 } from "lucide-react";
import { type ChangeEvent, useActionState, useRef, useState } from "react";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "@/lib/files";
import { WORKSHOP_LIMITS, workshopFileFormat, workshopFileProblem } from "@/lib/workshop";
import { useFocusFirstError } from "../auth/use-focus-first-error";
import type { FormAction } from "../tasks/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, FieldError, Input } from "../ui/field";
import { FormMessage } from "../ui/form-message";
import { SubmitButton } from "../ui/submit-button";

const NO_FILE = "Choose a file to add.";

/**
 * Add a design file (STL, STEP, 3MF…) to a project. The picked file is checked right away (type by its name, size)
 * and kept here, not in the file input, so it survives a save that comes back with an error; one the server refuses
 * is taken off, and why is said aloud. After it's added, the form is cleared. A failed add puts focus on the first
 * field to fix.
 */
export function WorkshopFileAddForm({ projectId, action }: { projectId: string; action: FormAction }) {
  const [picked, setPicked] = useState<File | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pickedAtNonce, setPickedAtNonce] = useState<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const sent = picked;
    if (!sent) {
      setAnnouncement(NO_FILE);
      const label = formData.get("label");
      return { ok: false, fieldErrors: { file: NO_FILE }, values: typeof label === "string" ? { label } : {}, nonce: Date.now() };
    }
    formData.set("file", sent);
    const result = await action(prev, formData);
    if (result?.ok || result?.fieldErrors?.file) {
      // Added (ready for the next one), or refused by the server (the picker shows why, with nothing picked, and it's
      // said aloud).
      setAnnouncement(result?.fieldErrors?.file ?? "");
      setPicked((now) => (now === sent ? null : now));
      if (inputRef.current) inputRef.current.value = "";
    }
    return result;
  }, initialActionState);
  useFocusFirstError(state, formRef);

  const serverError = state && !state.ok && state.nonce !== pickedAtNonce ? state.fieldErrors?.file : undefined;
  const error = pickError ?? serverError;
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    setPickedAtNonce(state?.nonce);
    if (!file) return; // cancelled: keep what was there
    const problem = workshopFileProblem(file, LIMITS.resourceFileMaxBytes);
    if (problem) {
      setPicked(null);
      setPickError(problem);
      setAnnouncement(problem);
      input.value = "";
      return;
    }
    setPickError(null);
    setPicked(file);
    setAnnouncement(`Picked “${file.name}” (${formatFileSize(file.size)}).`);
  }

  function clearPicked() {
    setPicked(null);
    setPickError(null);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
    setAnnouncement("File taken off.");
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-4" noValidate>
      {state && (state.ok || !state.fieldErrors) && <FormMessage state={state} />}
      <input type="hidden" name="projectId" value={projectId} />

      <div className="space-y-2">
        <p id="design-file-label" className="text-sm font-medium text-ink-800">
          Design file
        </p>
        {picked && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
            <Badge tone="brand" className="font-mono">
              {workshopFileFormat(picked.name)}
            </Badge>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-ink-900 wrap-anywhere">{picked.name}</p>
              <p className="text-ink-500">{formatFileSize(picked.size)} · uploads when you add it</p>
            </div>
            <Button variant="ghost" onClick={clearPicked} aria-label={`Take off ${picked.name}`}>
              <Trash2 className="size-4" aria-hidden />
              Take off
            </Button>
          </div>
        )}
        <div>
          <input
            ref={inputRef}
            id="design-file"
            type="file"
            // No `accept` list: iPhones grey out CAD files (.stl, .step…) they don't recognize. workshopFileProblem checks instead.
            onChange={pick}
            aria-labelledby="design-file-label design-file-choose"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "design-file-error design-file-hint" : "design-file-hint"}
            className="peer sr-only"
          />
          <label
            id="design-file-choose"
            htmlFor="design-file"
            className={cn(
              "flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm font-medium transition-colors",
              "peer-focus:ring-2 peer-focus:ring-brand-500/40",
              error ? "border-red-400 text-red-700 hover:bg-red-50" : "border-brand-300 bg-brand-50/50 text-brand-800 hover:bg-brand-50",
            )}
          >
            <FilePlus2 className="size-5 shrink-0" aria-hidden />
            {picked ? "Choose a different file" : "Choose a file"}
          </label>
        </div>
        <FieldError id="design-file-error">{error}</FieldError>
        <p id="design-file-hint" className="text-xs text-ink-500">
          {`Up to ${RESOURCE_FILE_MAX_MB} MB each. Bigger? Put it on Onshape, Printables, or Google Drive and add the link in Edit details.`}
        </p>
        <p role="status" className="sr-only">
          {announcement}
        </p>
      </div>

      <Field label="Label" htmlFor="design-file-name" error={errors.label} optional key={state?.nonce ?? 0}>
        <Input
          id="design-file-name"
          name="label"
          maxLength={WORKSHOP_LIMITS.fileLabelMax}
          defaultValue={(state && !state.ok ? state.values?.label : undefined) ?? ""}
          invalid={!!errors.label}
          aria-describedby={errors.label ? "design-file-name-error" : undefined}
          placeholder="Print-ready STL"
          autoComplete="off"
        />
      </Field>

      <div className="flex justify-end">
        <SubmitButton pendingText="Uploading…" className="w-full sm:w-auto">
          <FilePlus2 className="size-4" aria-hidden />
          Add file
        </SubmitButton>
      </div>
    </form>
  );
}
