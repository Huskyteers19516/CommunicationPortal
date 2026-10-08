"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import type { ButtonVariant } from "../ui/button";
import { SubmitButton } from "../ui/submit-button";

/** One-button form (Served, Void, Remove…) with hidden fields; says why when it's refused. */
export function SalesActionButton({
  action,
  fields,
  children,
  variant = "secondary",
  confirm,
  pendingText,
  className,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  children: React.ReactNode;
  variant?: ButtonVariant;
  confirm?: string;
  pendingText?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className={className}>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton variant={variant} size="sm" confirm={confirm} pendingText={pendingText}>
        {children}
      </SubmitButton>
      {state && !state.ok && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}
