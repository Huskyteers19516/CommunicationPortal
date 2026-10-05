"use client";

import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import type { FormAction } from "../tasks/types";
import type { ButtonSize, ButtonVariant } from "../ui/button";
import { SubmitButton } from "../ui/submit-button";

/**
 * A one-button form (Send for approval, Move up, Make cover, Remove…) posting hidden fields to a Server Action, with
 * the error shown under it. Like tasks/ActionForm, plus sizes and `disabled` (Move up on the first photo). When the
 * page re-renders around it (a photo moved), the button gets keyboard focus back instead of leaving it on <body> (or,
 * when it's disabled now, the first enabled button inside its `data-focus-group` ancestor).
 */
export function WorkshopActionButton({
  action,
  fields,
  children,
  variant = "secondary",
  size = "md",
  confirm,
  pendingText,
  disabled,
  className,
  buttonClassName,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: {
  action: FormAction;
  fields: Record<string, string>;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  confirm?: string;
  pendingText?: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The page's new content can arrive a render after the result (the button moves or turns disabled then), so
  // focus is put back after whichever render loses it, until focus has moved somewhere else.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (state?.ok) restoreFocus.current = true;
  }, [state]);
  useEffect(() => {
    if (!restoreFocus.current) return;
    const button = buttonRef.current;
    const active = document.activeElement;
    if (active && active !== document.body) {
      if (active !== button) restoreFocus.current = false;
      return;
    }
    restoreFocus.current = false;
    // Now disabled (Move up on what became the first photo): the first enabled button in its group instead.
    const target = button?.disabled
      ? button.closest("[data-focus-group]")?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      : button;
    target?.focus();
  });

  return (
    <form action={formAction} className={cn("inline-flex flex-col", className)}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton
        ref={buttonRef}
        variant={variant}
        size={size}
        confirm={confirm}
        pendingText={pendingText}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        className={buttonClassName}
      >
        {children}
      </SubmitButton>
      {state && !state.ok && state.message && (
        <p role="alert" className="mt-1 max-w-64 text-xs text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}
