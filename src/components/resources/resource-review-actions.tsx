"use client";

import { Check, Undo2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";
import { Button } from "../ui/button";
import { FieldError, Label, Textarea } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

/** A form action from useActionState (the parent owns the state, so its confirmation outlives this card). */
export type ReviewFormAction = (formData: FormData) => void;

/**
 * Approve / Send back for a member's resource. "Send back…" opens an inline panel with an optional
 * note that the member sees. The service re-checks everything.
 *
 * The parent (the Resources page's review queue, or the resource page's review card) owns the action
 * state; errors about this resource are shown here. Side by side on phones too, so cards stay short.
 */
export function ResourceReviewActions({
  resourceId,
  version,
  title,
  sharedByName,
  state,
  formAction,
  onSubmit,
  canSendBack = true,
}: {
  resourceId: string;
  /** The resource's updatedAt when this page loaded; a later edit by the member makes the review fail. */
  version: string;
  title: string;
  /** Who shared it (null when their account is gone). */
  sharedByName: string | null;
  state: ActionState;
  formAction: ReviewFormAction;
  /** Called just before either form is sent (the queue uses it to move focus afterwards). */
  onSubmit?: (resourceId: string) => void;
  /** Off when it was already sent back (it can still be approved). */
  canSendBack?: boolean;
}) {
  const panelId = useId();
  const noteId = `${panelId}-note`;
  const hintId = `${panelId}-hint`;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // The parent's state is shared by every card: only show what failed for this resource.
  const failed = state && !state.ok && state.values?.resourceId === resourceId ? state : null;
  const approveError = failed?.values?.decision === "approve" ? failed.message : undefined;
  const rejectFailed = failed?.values?.decision === "reject" ? failed : null;
  const noteError = rejectFailed?.fieldErrors?.note;
  const first = sharedByName?.trim().split(/\s+/)[0] || null;

  function closePanel() {
    setOpen(false);
    toggleRef.current?.focus();
  }

  const hidden = (decision: "approve" | "reject") => (
    <>
      <input type="hidden" name="resourceId" value={resourceId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-start">
        <form action={formAction} onSubmit={() => onSubmit?.(resourceId)} className="min-w-0">
          {hidden("approve")}
          <SubmitButton
            variant="success"
            className="w-full sm:w-auto"
            pendingText="Approving…"
            aria-label={`Approve ${title}`}
            data-review-approve={resourceId}
          >
            <Check className="size-4" aria-hidden />
            Approve
          </SubmitButton>
        </form>
        {canSendBack && (
          <Button
            ref={toggleRef}
            variant="secondary"
            className="w-full sm:w-auto"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={`Send back ${title}`}
            onClick={() => setOpen((o) => !o)}
          >
            <Undo2 className="size-4" aria-hidden />
            Send back…
          </Button>
        )}
      </div>
      {approveError && (
        <p role="alert" className="text-sm text-red-600 wrap-anywhere">
          {approveError}
        </p>
      )}
      {canSendBack && open && (
        <form
          id={panelId}
          action={formAction}
          onSubmit={() => onSubmit?.(resourceId)}
          className="space-y-2 rounded-lg border border-ink-200 bg-ink-50 p-3"
        >
          {hidden("reject")}
          <Label htmlFor={noteId}>
            Note for {first ?? "the member"}
            <span className="ml-1 font-normal text-ink-500">(optional)</span>
          </Label>
          <Textarea
            // Remount after a failed send so it shows what was typed (and takes focus again).
            key={rejectFailed?.nonce ?? "note"}
            id={noteId}
            name="note"
            rows={3}
            maxLength={LIMITS.noteMax}
            autoFocus
            defaultValue={rejectFailed?.values?.note ?? ""}
            placeholder="What should they change?"
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
              {first ? `${first} sees` : "They see"} this note, so they can fix it and share it again.
            </p>
          )}
          <FieldError id={`${noteId}-error`}>{noteError}</FieldError>
          {rejectFailed && !noteError && rejectFailed.message && (
            <p role="alert" className="text-sm text-red-600 wrap-anywhere">
              {rejectFailed.message}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <SubmitButton
              variant="danger"
              className="w-full sm:w-auto"
              pendingText="Sending…"
              aria-label={`Send back ${title} to ${first ?? "the member"}`}
            >
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
