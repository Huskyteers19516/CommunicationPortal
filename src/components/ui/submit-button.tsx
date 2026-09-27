"use client";

import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/cn";
import { Button } from "./button";

/**
 * Submit button that shows a spinner and ignores further presses while its <form> is submitting.
 * Pass `confirm` to ask before submitting (e.g. destructive actions).
 *
 * While pending it is `aria-disabled` rather than `disabled`: a disabled button drops keyboard focus
 * to <body>, so keyboard and screen-reader users would lose their place after every inline action.
 * Presses (and Enter in a field, which "clicks" the default button) are cancelled instead.
 */
export function SubmitButton({
  children,
  pendingText,
  confirm: confirmText,
  disabled,
  onClick,
  className,
  ...props
}: ComponentProps<typeof Button> & { pendingText?: string; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={disabled}
      aria-disabled={pending || undefined}
      aria-busy={pending}
      className={cn(pending && "cursor-wait opacity-60", className)}
      onClick={(e) => {
        if (pending) {
          e.preventDefault();
          return;
        }
        if (confirmText && !window.confirm(confirmText)) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...props}
    >
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {pending && pendingText ? pendingText : children}
    </Button>
  );
}
