"use client";

import { LogOut, UserPlus } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { leaveTaskAction, signUpForTaskAction } from "@/app/(app)/tasks/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import type { BoardTask } from "@/server/queries/board";
import { SubmitButton } from "../ui/submit-button";

const SIGNED_UP = "You're on it — it's on your Today list.";
const LEFT = "You left this task.";

function ErrorLine({ state }: { state: ActionState }) {
  if (!state || state.ok || !state.message) return null;
  return (
    <p role="alert" className="mt-1 max-w-64 text-xs text-red-600">
      {state.message}
    </p>
  );
}

/**
 * Sign up / Leave for one task (dashboard cards and the task page). Signing up swaps the button for
 * "Leave" (and back), so focus follows to the new button and a status line says what happened —
 * otherwise keyboard and screen-reader users would land on <body>.
 */
export function SignupButtons({
  task,
  className,
}: {
  task: Pick<BoardTask, "id" | "title" | "canSignUp" | "canLeave">;
  className?: string;
}) {
  const [signUpState, signUpAction] = useActionState(signUpForTaskAction, initialActionState);
  const [leaveState, leaveAction] = useActionState(leaveTaskAction, initialActionState);
  const signUpRef = useRef<HTMLButtonElement>(null);
  const leaveRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // The most recent successful action decides the status line (nonces grow over time).
  const signUpNonce = signUpState?.ok ? (signUpState.nonce ?? 0) : 0;
  const leaveNonce = leaveState?.ok ? (leaveState.nonce ?? 0) : 0;
  const message = signUpNonce > leaveNonce ? SIGNED_UP : leaveNonce > signUpNonce ? LEFT : "";

  // The page data (and so which button shows) updates together with the action result.
  useEffect(() => {
    if (!signUpNonce) return;
    (leaveRef.current ?? cardTitle(statusRef.current) ?? statusRef.current)?.focus();
  }, [signUpNonce]);
  useEffect(() => {
    if (!leaveNonce) return;
    (signUpRef.current ?? cardTitle(statusRef.current) ?? statusRef.current)?.focus();
  }, [leaveNonce]);

  const hasButtons = task.canSignUp || task.canLeave;
  return (
    <div className={cn((hasButtons || message) && className)}>
      {hasButtons && (
        <div className="flex flex-wrap gap-2">
          {task.canSignUp && (
            <form action={signUpAction} className="inline-flex flex-col">
              <input type="hidden" name="taskId" value={task.id} />
              <SubmitButton ref={signUpRef} variant="primary" pendingText="Signing up…" aria-label={`Sign up for ${task.title}`}>
                <UserPlus className="size-4" aria-hidden />
                Sign up
              </SubmitButton>
              <ErrorLine state={signUpState} />
            </form>
          )}
          {task.canLeave && (
            <form action={leaveAction} className="inline-flex flex-col">
              <input type="hidden" name="taskId" value={task.id} />
              <SubmitButton
                ref={leaveRef}
                variant="secondary"
                pendingText="Leaving…"
                confirm={`Leave “${task.title}”? It comes off your checklist and frees your spot.`}
                aria-label={`Leave ${task.title}`}
              >
                <LogOut className="size-4" aria-hidden />
                Leave
              </SubmitButton>
              <ErrorLine state={leaveState} />
            </form>
          )}
        </div>
      )}
      {/* Always rendered so screen readers announce it; focused as a last resort (tabIndex -1). */}
      <p ref={statusRef} role="status" tabIndex={-1} className={cn("text-xs text-brand-700", message && hasButtons && "mt-2")}>
        {message}
      </p>
    </div>
  );
}

/** On a dashboard card, the task's title link (the card's main way in). */
function cardTitle(from: HTMLElement | null): HTMLElement | null {
  return from?.closest("article")?.querySelector<HTMLElement>("a[href^='/tasks/']") ?? null;
}
