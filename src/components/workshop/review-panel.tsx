"use client";

import { Check, Undo2 } from "lucide-react";
import { useActionState, useId, useRef, useState } from "react";
import { initialActionState } from "@/lib/action-state";
import { WORKSHOP_LIMITS } from "@/lib/workshop";
import type { FormAction } from "../tasks/types";
import { Button } from "../ui/button";
import { FieldError, Label, Textarea } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

/**
 * Reviewers, on a project waiting for approval: Approve (it goes on the team website), or "Send back…" with a note
 * saying what to change (required). Both land back on the project page with a confirmation. Both send `version` (the
 * project's updatedAt, ISO): when it changed since the page showed it, the decision is refused, the page refreshes,
 * and the reason shows here.
 */
export function WorkshopReviewPanel({
  projectId,
  version,
  title,
  action,
}: {
  projectId: string;
  version: string;
  title: string;
  action: FormAction;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const panelId = useId();
  const noteId = `${panelId}-note`;
  const hintId = `${panelId}-hint`;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const failed = state && !state.ok ? state : null;
  const rejectFailed = failed?.values?.decision === "reject" ? failed : null;
  const approveError = failed?.values?.decision === "approve" ? failed.message : undefined;
  const noteError = rejectFailed?.fieldErrors?.note;
  const [open, setOpen] = useState(false);

  function closePanel() {
    setOpen(false);
    toggleRef.current?.focus();
  }

  const hidden = (decision: "approve" | "reject") => (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-start">
        <form action={formAction} className="min-w-0">
          {hidden("approve")}
          <SubmitButton variant="success" className="w-full sm:w-auto" pendingText="Approving…" aria-label={`Approve ${title}`}>
            <Check className="size-4" aria-hidden />
            Approve
          </SubmitButton>
        </form>
        <Button
          ref={toggleRef}
          variant="secondary"
          className="w-full sm:w-auto"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? closePanel() : setOpen(true))}
        >
          <Undo2 className="size-4" aria-hidden />
          Send back…
        </Button>
      </div>
      {approveError && (
        <p role="alert" className="text-sm text-red-600 wrap-anywhere">
          {approveError}
        </p>
      )}
      {open && (
        <form id={panelId} action={formAction} className="space-y-2 rounded-lg border border-ink-200 bg-white p-3" noValidate>
          {hidden("reject")}
          <Label htmlFor={noteId}>What needs to change?</Label>
          <Textarea
            // Remount after a failed send so it shows what was typed (and takes focus again).
            key={rejectFailed?.nonce ?? "note"}
            id={noteId}
            name="note"
            rows={3}
            required
            maxLength={WORKSHOP_LIMITS.reviewNoteMax}
            autoFocus
            defaultValue={rejectFailed?.values?.note ?? ""}
            placeholder="e.g. Add a photo of the finished part, and say what material Version 2 is."
            invalid={!!noteError}
            aria-describedby={noteError ? `${noteId}-error` : hintId}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closePanel();
              }
            }}
          />
          {!noteError && (
            <p id={hintId} className="text-xs text-ink-500">
              The people who can change it see this note, so they can fix it and send it again.
            </p>
          )}
          <FieldError id={`${noteId}-error`}>{noteError}</FieldError>
          {rejectFailed && !noteError && rejectFailed.message && (
            <p role="alert" className="text-sm text-red-600 wrap-anywhere">
              {rejectFailed.message}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <SubmitButton variant="danger" className="w-full sm:w-auto" pendingText="Sending…" aria-label={`Send back ${title}`}>
              <Undo2 className="size-4" aria-hidden />
              Send back
            </SubmitButton>
            <Button variant="ghost" className="w-full sm:w-auto" onClick={closePanel}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
