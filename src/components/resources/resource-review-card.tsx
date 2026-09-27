"use client";

import { CircleCheck } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useId, useRef } from "react";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { ResourceReviewActions } from "./resource-review-actions";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * The reviewer's decision on a resource's own page, shown after its content (read first, then
 * decide). After a review, the confirmation replaces or tops the card and takes focus; the page
 * itself refreshes to the new status. Keep it mounted for every reviewer (`reviewable` false once
 * approved) so the confirmation survives the refresh.
 */
export function ResourceReviewCard({
  resourceId,
  version,
  title,
  sharedByName,
  reviewable,
  canSendBack,
  heading,
  action,
  children,
}: {
  resourceId: string;
  version: string;
  title: string;
  sharedByName: string | null;
  /** Waiting or sent back: it can be approved now. */
  reviewable: boolean;
  canSendBack: boolean;
  heading: string;
  action: Action;
  /** Where it stands (who shared it, the earlier note…), rendered by the page. */
  children?: ReactNode;
}) {
  const headingId = useId();
  const [state, formAction] = useActionState(action, initialActionState);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const done = state?.ok ? state.message : undefined;

  useEffect(() => {
    if (state?.ok) statusRef.current?.focus();
  }, [state]);

  if (!reviewable && !done) return null;

  return (
    <div className="space-y-3">
      {/* Always rendered (empty when idle) so screen readers announce the confirmation. */}
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className={
          done
            ? "flex items-start gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3.5 py-3 text-sm text-brand-900 focus:outline-none"
            : "sr-only"
        }
      >
        {done && <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />}
        {done && <span className="min-w-0 wrap-anywhere">{done}</span>}
      </p>
      {reviewable && (
        <section aria-labelledby={headingId} className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 id={headingId} className="text-base font-semibold text-ink-900">
            {heading}
          </h2>
          {children && <div className="mt-1 space-y-3 text-sm text-ink-600">{children}</div>}
          <div className="mt-4">
            {/* A new version (e.g. after sending it back) starts with the panel closed. */}
            <ResourceReviewActions
              key={version}
              resourceId={resourceId}
              version={version}
              title={title}
              sharedByName={sharedByName}
              state={state}
              formAction={formAction}
              canSendBack={canSendBack}
            />
          </div>
        </section>
      )}
    </div>
  );
}
