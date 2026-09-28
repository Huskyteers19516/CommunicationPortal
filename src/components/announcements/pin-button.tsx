"use client";

import { Pin, PinOff } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { setAnnouncementPinnedAction } from "@/app/(app)/announcements/actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { useDismissCardNotice } from "./card-notice";

/** Room the phone's sticky top bar and bottom tab bar take (and a little air). */
const TOP_INSET = 72;
const BOTTOM_INSET = 88;

/**
 * Pin to top / Unpin (whoever can edit the announcement). Only the button's words change, so keyboard focus stays
 * on it, and a short status line under it says what happened. The list re-sorts when the page refreshes (pinned
 * ones first), which can move the card far up or down: then the page scrolls so the button and its status line are
 * in view again.
 */
export function AnnouncementPinButton({ announcementId, title, pinned }: { announcementId: string; title: string; pinned: boolean }) {
  const [state, formAction] = useActionState(setAnnouncementPinnedAction, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  const dismissNotice = useDismissCardNotice();
  // The press being answered: what it asked for, and the state before it (its answer is the next one). Until the
  // list shows the new order, the card may still move.
  const press = useRef<{ expected: boolean; before: typeof state } | null>(null);
  const message = state?.ok ? (state.message ?? "") : "";

  useEffect(() => {
    const p = press.current;
    const form = formRef.current;
    if (!p || !form || state === p.before) return;
    // A moved element can lose focus: put it back on the button.
    const active = document.activeElement;
    if (!active || active === document.body) form.querySelector("button")?.focus({ preventScroll: true });
    if (state?.ok && pinned !== p.expected) return; // the list hasn't re-sorted yet
    press.current = null;
    if (!state?.ok) return;
    const box = form.getBoundingClientRect();
    if (box.top < TOP_INSET || box.bottom > window.innerHeight - BOTTOM_INSET) form.scrollIntoView({ block: "center" });
  }, [state, pinned]);

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={() => {
        press.current = { expected: !pinned, before: state };
        // "Changes saved." (or "Posted.") on this card is old news now.
        dismissNotice?.();
      }}
      className="inline-flex flex-col items-start"
    >
      <input type="hidden" name="announcementId" value={announcementId} />
      {!pinned && <input type="hidden" name="pinned" value="on" />}
      <SubmitButton
        variant="secondary"
        pendingText={pinned ? "Unpinning…" : "Pinning…"}
        // Starts with the words on the button (so "click Pin to top" works with voice control).
        aria-label={pinned ? `Unpin “${title}”` : `Pin to top: “${title}”`}
      >
        {pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}
        {pinned ? "Unpin" : "Pin to top"}
      </SubmitButton>
      {/* Always rendered, so screen readers announce what changes in it. As wide as the button (never wider). */}
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
