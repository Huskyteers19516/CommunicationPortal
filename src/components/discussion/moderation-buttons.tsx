"use client";

import { Lock, LockOpen, Pin, PinOff } from "lucide-react";
import { type ReactNode, useActionState } from "react";
import { setThreadLockedAction, setThreadPinnedAction } from "@/app/(app)/discussion/actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import type { FormAction } from "@/components/tasks/types";

/**
 * One on/off button (Pin to top / Unpin, Lock / Unlock). It stays where it is (only its words change), so keyboard
 * focus stays on it, and a status line under it says what happened.
 */
function ToggleButton({
  action,
  threadId,
  field,
  on,
  label,
  pendingText,
}: {
  action: FormAction;
  threadId: string;
  field: "pinned" | "locked";
  /** The state it's in now: the button turns it the other way. */
  on: boolean;
  label: ReactNode;
  pendingText: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const message = state?.ok ? (state.message ?? "") : "";
  return (
    <form action={formAction} className="inline-flex flex-col items-start">
      <input type="hidden" name="threadId" value={threadId} />
      {!on && <input type="hidden" name={field} value="on" />}
      <SubmitButton variant="secondary" pendingText={pendingText}>
        {label}
      </SubmitButton>
      {/* Always rendered, so screen readers announce what changes in it; as wide as the button, never wider. */}
      <p role="status" className={cn("w-0 min-w-full text-xs text-brand-700", message && "mt-1")}>
        {message}
      </p>
      {state && !state.ok && state.message && (
        <p role="alert" className="mt-1 max-w-64 text-xs text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Pin / lock a discussion (people with admin access). */
export function ModerationButtons({ threadId, pinned, locked }: { threadId: string; pinned: boolean; locked: boolean }) {
  return (
    <>
      <ToggleButton
        action={setThreadPinnedAction}
        threadId={threadId}
        field="pinned"
        on={pinned}
        pendingText={pinned ? "Unpinning…" : "Pinning…"}
        label={
          pinned ? (
            <>
              <PinOff className="size-4" aria-hidden />
              Unpin
            </>
          ) : (
            <>
              <Pin className="size-4" aria-hidden />
              Pin to top
            </>
          )
        }
      />
      <ToggleButton
        action={setThreadLockedAction}
        threadId={threadId}
        field="locked"
        on={locked}
        pendingText={locked ? "Unlocking…" : "Locking…"}
        label={
          locked ? (
            <>
              <LockOpen className="size-4" aria-hidden />
              Unlock
            </>
          ) : (
            <>
              <Lock className="size-4" aria-hidden />
              Lock
            </>
          )
        }
      />
    </>
  );
}
