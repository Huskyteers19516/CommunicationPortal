"use client";

import { CircleCheck } from "lucide-react";
import { createContext, type ReactNode, useActionState, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { ResourceReviewActions, type ReviewFormAction } from "./resource-review-actions";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

interface QueueContext {
  state: ActionState;
  formAction: ReviewFormAction;
  willSubmit: (resourceId: string) => void;
}

const ReviewQueueContext = createContext<QueueContext | null>(null);

/**
 * The reviewers' "Waiting for approval" section on the Resources page. One action state for every
 * card, so the confirmation ("Approved “X” — …") stays after that card disappears. Afterwards focus
 * goes to the next card's Approve button (or the confirmation when none is left), not to <body>.
 * Stays on screen after the last one is reviewed, to show the confirmation.
 */
export function ResourceReviewQueue({
  count,
  itemIds,
  action,
  headingClassName,
  children,
}: {
  count: number;
  /** The pending resources shown, in order. */
  itemIds: string[];
  action: Action;
  headingClassName?: string;
  /** The list of cards (each with <QueueReviewActions>). */
  children: ReactNode;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const sectionRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  /** The resource just sent, and the order of the cards at that moment. */
  const submitted = useRef<{ id: string; order: string[] } | null>(null);

  const willSubmit = useCallback((id: string) => {
    const buttons = sectionRef.current?.querySelectorAll<HTMLElement>("[data-review-approve]") ?? [];
    submitted.current = { id, order: Array.from(buttons, (b) => b.dataset.reviewApprove ?? "") };
  }, []);

  useEffect(() => {
    if (!state?.ok) return;
    const last = submitted.current;
    submitted.current = null;
    const root = sectionRef.current;
    if (last && root) {
      // The next card, else the one before it (the reviewed card is gone or about to go).
      const at = last.order.indexOf(last.id);
      const candidates = [...last.order.slice(at + 1), ...last.order.slice(0, Math.max(at, 0)).reverse()];
      for (const id of candidates) {
        const button = root.querySelector<HTMLElement>(`[data-review-approve="${CSS.escape(id)}"]`);
        if (button) {
          button.focus();
          return;
        }
      }
    }
    statusRef.current?.focus();
  }, [state]);

  const context = useMemo(() => ({ state, formAction, willSubmit }), [state, formAction, willSubmit]);
  const done = state?.ok ? state.message : undefined;
  // An error for a card that isn't listed any more (it can't be shown on the card).
  const orphanError = state && !state.ok && !itemIds.includes(state.values?.resourceId ?? "") ? state.message : undefined;

  if (count === 0 && !done) return null;

  return (
    <section ref={sectionRef} id="pending" aria-labelledby="pending-heading" className="scroll-mt-20">
      <h2 id="pending-heading" className={cn(headingClassName, "mb-1")}>
        Waiting for approval{count > 0 && ` (${count})`}
      </h2>
      <p className="mb-3 text-sm text-ink-500">
        {count > 0 ? "Members shared these. The team sees them once someone approves them." : "Nothing else is waiting."}
      </p>
      {/* Always rendered (empty when idle) so screen readers announce each confirmation. */}
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className={
          done
            ? "mb-3 flex items-start gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-900 focus:outline-none"
            : "sr-only"
        }
      >
        {done && <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />}
        {done && <span className="min-w-0 wrap-anywhere">{done}</span>}
      </p>
      {orphanError && (
        <p role="alert" className="mb-3 text-sm text-red-600 wrap-anywhere">
          {orphanError}
        </p>
      )}
      <ReviewQueueContext.Provider value={context}>{count > 0 && children}</ReviewQueueContext.Provider>
    </section>
  );
}

/** Approve / Send back on one card inside <ResourceReviewQueue>. */
export function QueueReviewActions(props: { resourceId: string; version: string; title: string; sharedByName: string | null }) {
  const queue = useContext(ReviewQueueContext);
  if (!queue) return null;
  return <ResourceReviewActions {...props} state={queue.state} formAction={queue.formAction} onSubmit={queue.willSubmit} />;
}
