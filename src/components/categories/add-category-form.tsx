"use client";

import { Plus } from "lucide-react";
import { type KeyboardEvent, type RefObject, useActionState, useEffect, useId, useRef } from "react";
import { createCategoryAction } from "@/app/(app)/manage/categories/actions";
import type { Subteam } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { Button } from "../ui/button";
import { FieldError, Input, Label } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

/**
 * Add a category to one subteam's list. Used inline on the Task dashboard ("Category" in a section
 * header, with `onAdded` / `onCancel` to close it) and on Manage → Categories (always open).
 * After an error focus goes back to the name field; with `focusAfterAdd` it also stays there after
 * a success, ready for the next name.
 */
export function AddCategoryForm({
  subteam,
  listLabel,
  onAdded,
  onCancel,
  autoFocus = false,
  focusAfterAdd = false,
  inputRef,
  className,
}: {
  /** "" = whole team. */
  subteam: "" | Subteam;
  /** "Build" / "Whole team", for the label. */
  listLabel: string;
  /** Called after a successful add with the confirmation message. */
  onAdded?: (message: string) => void;
  /** Shows a Cancel button (and Escape) when set. */
  onCancel?: () => void;
  autoFocus?: boolean;
  /** Keep focus in the name field after a successful add (the form stays open). */
  focusAfterAdd?: boolean;
  /** Lets the page focus the name field (e.g. after the last category is deleted). */
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const inputId = useId();
  const ownInputRef = useRef<HTMLInputElement>(null);
  const nameRef = inputRef ?? ownInputRef;
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await createCategoryAction(prev, formData);
    } catch {
      const name = formData.get("name");
      return { ok: false, message: OFFLINE_MESSAGE, values: { name: typeof name === "string" ? name : "" }, nonce: Date.now() };
    }
    if (result?.ok) onAdded?.(result.message ?? "Category added.");
    return result;
  }, initialActionState);

  const error = state && !state.ok ? (state.fieldErrors?.name ?? state.message) : undefined;
  const errorId = `${inputId}-error`;

  // Each result is a new object: put focus back in the field so the error is read out (or the next
  // name can be typed) instead of leaving keyboard users wherever the button was.
  useEffect(() => {
    if (!state) return;
    if (!state.ok || focusAfterAdd) nameRef.current?.focus();
  }, [state, focusAfterAdd, nameRef]);

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <form action={formAction} onKeyDown={onKeyDown} className={cn("space-y-1.5", className)} aria-label={`Add a category to ${listLabel}`}>
      <input type="hidden" name="subteam" value={subteam} />
      <Label htmlFor={inputId}>New {listLabel === "Whole team" ? "whole-team" : listLabel} category</Label>
      {/* In a narrow dashboard column the buttons wrap under the input instead of squeezing it. */}
      <div className="flex flex-wrap gap-2">
        <Input
          ref={nameRef}
          id={inputId}
          name="name"
          required
          maxLength={LIMITS.categoryNameMax}
          // React resets the form after the action; keep what was typed when it failed.
          defaultValue={state && !state.ok ? (state.values?.name ?? "") : ""}
          placeholder="e.g. Intake"
          autoComplete="off"
          autoFocus={autoFocus}
          invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className="min-w-40 flex-[1_1_10rem]"
        />
        <SubmitButton pendingText="Adding…" className="shrink-0">
          <Plus className="size-4" aria-hidden />
          Add
        </SubmitButton>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} className="shrink-0">
            Cancel
          </Button>
        )}
      </div>
      <FieldError id={errorId}>{error}</FieldError>
      {/* Always in the DOM so screen readers announce the message when it appears. */}
      {!onAdded && (
        <p role="status" className="text-sm text-brand-700 empty:hidden">
          {state?.ok ? state.message : null}
        </p>
      )}
    </form>
  );
}
