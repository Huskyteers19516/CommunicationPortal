"use client";

import { Check, Undo2 } from "lucide-react";
import { type ReactNode, useActionState, useId, useState } from "react";
import { initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";
import { Button } from "../ui/button";
import { FieldError, Label, Textarea } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";
import type { FormAction } from "./types";

/**
 * Approve / Send back for one submission. "Send back" opens an inline panel that requires a note.
 * `extra` renders more buttons in the same row (e.g. Remove on the task page). `allowSendBack={false}` (a task
 * marked finished: nobody can check it off again) leaves only Approve.
 */
export function ReviewActions({
  assignmentId,
  personName,
  action,
  extra,
  allowSendBack = true,
}: {
  assignmentId: string;
  personName: string;
  action: FormAction;
  extra?: ReactNode;
  allowSendBack?: boolean;
}) {
  const panelId = useId();
  const noteId = `${panelId}-note`;
  const [approveState, approveAction] = useActionState(action, initialActionState);
  const [rejectState, rejectAction] = useActionState(action, initialActionState);
  const [open, setOpen] = useState(false);
  const noteError = rejectState?.fieldErrors?.note;
  const firstName = personName.trim().split(/\s+/)[0] || "them";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <form action={approveAction}>
          <input type="hidden" name="assignmentId" value={assignmentId} />
          <input type="hidden" name="decision" value="approve" />
          <SubmitButton variant="success" pendingText="Approving…" aria-label={`Approve ${personName}'s submission`}>
            <Check className="size-4" aria-hidden />
            Approve
          </SubmitButton>
        </form>
        {allowSendBack && (
          <Button
            variant="secondary"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`Send back ${personName}'s submission`}
            onClick={() => setOpen((o) => !o)}
          >
            <Undo2 className="size-4" aria-hidden />
            Send back
          </Button>
        )}
        {extra}
      </div>
      {approveState && !approveState.ok && approveState.message && (
        <p role="alert" className="text-sm text-red-600">
          {approveState.message}
        </p>
      )}
      {open && allowSendBack && (
        <form id={panelId} action={rejectAction} className="space-y-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
          <input type="hidden" name="assignmentId" value={assignmentId} />
          <input type="hidden" name="decision" value="reject" />
          <Label htmlFor={noteId}>What should {firstName} change?</Label>
          <Textarea
            id={noteId}
            name="note"
            rows={3}
            required
            maxLength={LIMITS.noteMax}
            autoFocus
            defaultValue={rejectState?.values?.note ?? ""}
            placeholder="Be specific so they can fix it quickly."
            invalid={!!noteError}
            aria-describedby={noteError ? `${noteId}-error` : undefined}
          />
          <FieldError id={`${noteId}-error`}>{noteError}</FieldError>
          {rejectState && !rejectState.ok && !noteError && rejectState.message && (
            <p role="alert" className="text-sm text-red-600">
              {rejectState.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <SubmitButton variant="danger" pendingText="Sending…" aria-label={`Send back to ${personName} with this note`}>
              Send back
            </SubmitButton>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
