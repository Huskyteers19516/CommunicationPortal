"use client";

import { ArrowRightLeft, PlugZap, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useActionState } from "react";
import {
  cleanUpFileStorageAction,
  moveFilesToObjectStorageAction,
  testFileStorageAction,
} from "@/app/(app)/admin/actions";
import { Alert } from "@/components/ui/alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** One owner tool: a button, and what happened last time it was pressed. */
function Tool({
  action,
  children,
  pendingText,
  hint,
  variant = "secondary",
  disabled = false,
}: {
  action: Action;
  children: ReactNode;
  pendingText: string;
  hint?: string;
  variant?: "primary" | "secondary";
  /** Nothing to do right now. Stays on the card (not removed), so the last result stays readable after the refresh. */
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="space-y-2">
      <SubmitButton variant={variant} className="w-full" pendingText={pendingText} disabled={disabled}>
        {children}
      </SubmitButton>
      {hint && !disabled && <p className="text-xs text-ink-500">{hint}</p>}
      {state?.message && <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert>}
    </form>
  );
}

/**
 * The owners' buttons on the storage card (only shown while Cloudflare R2 is set up). Move and Clean up stay on the
 * card when there's nothing to do (disabled), so their last result is still shown after the page refreshes.
 */
export function FileStorageTools({
  moveLabel,
  canMove,
  waiting,
}: {
  /** "Move 12 files (38 MB) to R2". */
  moveLabel: string;
  canMove: boolean;
  waiting: number;
}) {
  return (
    <div className="space-y-3">
      <Tool action={testFileStorageAction} pendingText="Testing…" hint="Saves, reads back, and deletes a tiny test file.">
        <PlugZap className="size-4" aria-hidden />
        Test connection
      </Tool>
      <Tool
        action={moveFilesToObjectStorageAction}
        variant="primary"
        disabled={!canMove}
        pendingText="Moving… (up to a minute)"
        hint="Moves files that are still in the database, a batch per click. Everyone can keep using the portal meanwhile."
      >
        <ArrowRightLeft className="size-4" aria-hidden />
        {canMove ? moveLabel : "Every file is in R2"}
      </Tool>
      <Tool
        action={cleanUpFileStorageAction}
        disabled={waiting === 0}
        pendingText="Cleaning up…"
        hint="Deletes files that were removed in the portal from Cloudflare R2. This normally happens by itself."
      >
        <Trash2 className="size-4" aria-hidden />
        {waiting > 0 ? `Clean up (${waiting} waiting)` : "Nothing to clean up"}
      </Tool>
    </div>
  );
}
