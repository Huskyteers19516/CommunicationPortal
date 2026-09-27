"use client";

import { HandHeart, LogOut } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { unvolunteerAction, volunteerAction } from "@/app/(app)/fundraising/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import type { FundraiserItem } from "@/server/queries/fundraising";
import { SubmitButton } from "../ui/submit-button";

/** Only an element that's still on the page. */
function present(el: HTMLElement | null): HTMLElement | null {
  return el && el.isConnected ? el : null;
}

/** On a card, the fundraiser's name link (the card's main way in). */
function cardTitle(from: HTMLElement | null): HTMLElement | null {
  return from?.closest("article")?.querySelector<HTMLElement>("a[href^='/fundraising/']") ?? null;
}

/**
 * "I'll help" / "Leave" for one fundraiser (cards and the fundraiser page). Joining swaps the button for
 * "Leave" (and back), so focus follows to the new button and a status line says what happened. When it
 * fails (e.g. the last spot just went) the page refreshes; if the button is gone, focus moves to the message.
 */
export function VolunteerButtons({
  fundraiser,
  className,
}: {
  fundraiser: Pick<FundraiserItem, "id" | "name" | "canVolunteer" | "canLeave">;
  className?: string;
}) {
  const [helpState, helpAction] = useActionState(volunteerAction, initialActionState);
  const [leaveState, leaveAction] = useActionState(unvolunteerAction, initialActionState);
  const helpRef = useRef<HTMLButtonElement>(null);
  const leaveRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // The most recent result decides what's shown (nonces grow over time).
  const helpNonce = helpState?.nonce ?? 0;
  const leaveNonce = leaveState?.nonce ?? 0;
  const latest: ActionState = helpNonce > leaveNonce ? helpState : leaveNonce > helpNonce ? leaveState : null;
  const message = latest?.ok ? (latest.message ?? "") : "";
  const error = latest && !latest.ok ? (latest.message ?? "Something went wrong. Please try again.") : "";

  // The page data (and so which button shows) updates together with the action result.
  useEffect(() => {
    if (!helpState) return;
    if (helpState.ok) (present(leaveRef.current) ?? cardTitle(statusRef.current) ?? statusRef.current)?.focus();
    else if (!present(helpRef.current)) errorRef.current?.focus();
  }, [helpState]);
  useEffect(() => {
    if (!leaveState) return;
    if (leaveState.ok) (present(helpRef.current) ?? cardTitle(statusRef.current) ?? statusRef.current)?.focus();
    else if (!present(leaveRef.current)) errorRef.current?.focus();
  }, [leaveState]);

  const hasButtons = fundraiser.canVolunteer || fundraiser.canLeave;
  return (
    <div className={cn((hasButtons || message || error) && className)}>
      {hasButtons && (
        <div className="flex flex-wrap gap-2">
          {fundraiser.canVolunteer && (
            <form action={helpAction} className="inline-flex">
              <input type="hidden" name="fundraiserId" value={fundraiser.id} />
              <SubmitButton ref={helpRef} variant="primary" pendingText="Signing up…" aria-label={`I'll help with ${fundraiser.name}`}>
                <HandHeart className="size-4" aria-hidden />
                I&apos;ll help
              </SubmitButton>
            </form>
          )}
          {fundraiser.canLeave && (
            <form action={leaveAction} className="inline-flex">
              <input type="hidden" name="fundraiserId" value={fundraiser.id} />
              <SubmitButton
                ref={leaveRef}
                variant="secondary"
                pendingText="Leaving…"
                confirm={`Stop helping with “${fundraiser.name}”? Your spot opens up for someone else.`}
                aria-label={`Leave ${fundraiser.name}`}
              >
                <LogOut className="size-4" aria-hidden />
                Leave
              </SubmitButton>
            </form>
          )}
        </div>
      )}
      {error && (
        <p ref={errorRef} role="alert" tabIndex={-1} className={cn("text-sm text-red-600", hasButtons && "mt-2")}>
          {error}
        </p>
      )}
      {/* Always rendered so screen readers announce it; focused as a last resort (tabIndex -1). */}
      <p ref={statusRef} role="status" tabIndex={-1} className={cn("text-xs text-brand-700", message && hasButtons && "mt-2")}>
        {message}
      </p>
    </div>
  );
}
