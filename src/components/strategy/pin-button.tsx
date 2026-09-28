"use client";

import { Pin, PinOff } from "lucide-react";
import { useActionState } from "react";
import { setStrategyPinnedAction } from "@/app/(app)/strategy/actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";

/**
 * Pin to top / Unpin (people with admin access). The button stays where it is (only its words change), so
 * keyboard focus stays on it, and a short status line under it says what happened.
 */
export function PinButton({ strategyId, title, pinned }: { strategyId: string; title: string; pinned: boolean }) {
  const [state, formAction] = useActionState(setStrategyPinnedAction, initialActionState);
  const message = state?.ok ? (state.message ?? "") : "";
  return (
    <form action={formAction} className="inline-flex flex-col items-start">
      <input type="hidden" name="strategyId" value={strategyId} />
      {!pinned && <input type="hidden" name="pinned" value="on" />}
      <SubmitButton
        variant="secondary"
        pendingText={pinned ? "Unpinning…" : "Pinning…"}
        aria-label={pinned ? `Unpin ${title}` : `Pin ${title} to the top`}
      >
        {pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}
        {pinned ? "Unpin" : "Pin to top"}
      </SubmitButton>
      {/* Always rendered, so screen readers announce what changes in it. As wide as the button (never wider), so
          the buttons next to it don't move when it appears. */}
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
