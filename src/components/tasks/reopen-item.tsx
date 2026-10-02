"use client";

import { RotateCcw, Undo2 } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { reopenAssignmentAction } from "@/app/(app)/manage/tasks/actions";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { SubmitButton } from "../ui/submit-button";

/**
 * A manager's per-person "Reopen" on the manage task page: an approved item goes back on the person's checklist.
 * On a task marked finished it is "Take back credit" instead (with a confirm): the item stops counting and stays
 * closed — reopening the task won't give the credit back.
 *
 * Stays mounted while the item isn't approved, so the outcome can be shown (and announced) in its status line after
 * the button disappears; focus moves to that line so keyboard users keep their place.
 */
export function ReopenItem({
  assignmentId,
  personName,
  approved,
  taskFinished,
}: {
  assignmentId: string;
  personName: string;
  /** The item is approved (the button only shows then). */
  approved: boolean;
  taskFinished: boolean;
}) {
  const [state, action] = useActionState(reopenAssignmentAction, initialActionState);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const nonce = state?.ok ? (state.nonce ?? 0) : 0;
  const message = state?.ok ? (state.message ?? "") : "";

  useEffect(() => {
    if (nonce) statusRef.current?.focus();
  }, [nonce]);

  return (
    <>
      {approved && (
        <form action={action} className="inline-flex max-w-full flex-col items-start">
          <input type="hidden" name="assignmentId" value={assignmentId} />
          <SubmitButton
            variant="secondary"
            pendingText={taskFinished ? "Taking back…" : "Reopening…"}
            confirm={
              taskFinished ? `${personName} will no longer count for this task. The task stays finished.` : undefined
            }
            aria-label={taskFinished ? `Take back ${personName}'s credit` : `Reopen ${personName}'s checklist item`}
          >
            {taskFinished ? <Undo2 className="size-4" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
            {taskFinished ? "Take back credit" : "Reopen"}
          </SubmitButton>
          {state && !state.ok && state.message && (
            <p role="alert" className="mt-1 max-w-64 text-xs text-red-600">
              {state.message}
            </p>
          )}
        </form>
      )}
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className={cn("self-center text-xs text-brand-700", !message && "sr-only")}
      >
        {message}
      </p>
    </>
  );
}
