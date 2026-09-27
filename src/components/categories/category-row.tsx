"use client";

import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { type KeyboardEvent, type RefObject, useActionState, useEffect, useId, useRef, useState } from "react";
import { deleteCategoryAction, moveCategoryAction, renameCategoryAction } from "@/app/(app)/manage/categories/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";
import { ActionForm } from "../tasks/action-form";
import { Button } from "../ui/button";
import { FieldError, Input, Label } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

type Direction = "up" | "down";

/**
 * One category on Manage → Categories: rename inline, move up/down, delete.
 *
 * Focus stays put for keyboard users: after a move it stays on the same arrow (or the other one once
 * the category reaches the top/bottom); after a rename it goes back to "Rename". Deleting removes the
 * row, so the list (`onDeleted`) moves focus on. `onMessage` reports what happened for the list's
 * status line.
 */
export function CategoryRow({
  category,
  isFirst,
  isLast,
  onMessage,
  onDeleted,
}: {
  category: { id: string; name: string; taskCount: number };
  isFirst: boolean;
  isLast: boolean;
  onMessage?: (message: string) => void;
  /** Called once the category is gone (before the list re-renders without it). */
  onDeleted?: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const lastMove = useRef<Direction | null>(null);
  const handledMove = useRef<ActionState>(null);
  const { id, name, taskCount } = category;
  const tasks = `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`;

  // Both arrows post to one action; the result arrives together with the list in its new order.
  const [moveState, moveAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const direction: Direction = formData.get("direction") === "up" ? "up" : "down";
    lastMove.current = direction;
    let result: ActionState;
    try {
      result = await moveCategoryAction(prev, formData);
    } catch {
      return { ok: false, message: OFFLINE_MESSAGE, nonce: Date.now() };
    }
    if (result?.ok) onMessage?.(`Moved “${name}” ${direction}.`);
    return result;
  }, initialActionState);

  useEffect(() => {
    if (!moveState?.ok || handledMove.current === moveState) return;
    handledMove.current = moveState;
    // At the top the up arrow is disabled (and can't hold focus), so hand it to the other arrow.
    const target = lastMove.current === "up" ? (isFirst ? downRef : upRef) : isLast ? upRef : downRef;
    target.current?.focus();
  }, [moveState, isFirst, isLast]);

  async function deleteAction(prev: ActionState, formData: FormData): Promise<ActionState> {
    const result = await deleteCategoryAction(prev, formData);
    if (result?.ok) onDeleted?.(`Deleted “${name}”.`);
    return result;
  }

  function closeRename(message?: string) {
    setRenaming(false);
    if (message) onMessage?.(message);
    // The button is back after this render; focus it on the next frame.
    requestAnimationFrame(() => renameButtonRef.current?.focus());
  }

  if (renaming) return <RenameForm id={id} name={name} onDone={closeRename} />;

  const moveError = moveState && !moveState.ok ? moveState.message : undefined;

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 grow basis-0">
          <p className="text-sm font-medium text-ink-900 wrap-anywhere">{name}</p>
          <p className="text-xs text-ink-500">{tasks}</p>
        </div>
        <div className="-mr-2 flex shrink-0 items-center">
          <Button
            ref={renameButtonRef}
            data-rename=""
            variant="ghost"
            onClick={() => setRenaming(true)}
            aria-label={`Rename ${name}`}
          >
            <Pencil className="size-4" aria-hidden />
            <span className="hidden sm:inline">Rename</span>
          </Button>
          <MoveButton
            direction="up"
            categoryId={id}
            name={name}
            disabled={isFirst}
            action={moveAction}
            buttonRef={upRef}
          />
          <MoveButton
            direction="down"
            categoryId={id}
            name={name}
            disabled={isLast}
            action={moveAction}
            buttonRef={downRef}
          />
          <ActionForm
            action={deleteAction}
            fields={{ categoryId: id }}
            variant="ghost"
            pendingText="Deleting…"
            confirm={
              taskCount > 0
                ? `Delete “${name}”? Its ${tasks} stay on the dashboard, just without a category.`
                : `Delete “${name}”?`
            }
            aria-label={`Delete ${name}`}
          >
            <Trash2 className="size-4 text-red-600" aria-hidden />
            <span className="hidden sm:inline">Delete</span>
          </ActionForm>
        </div>
      </div>
      {moveError && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {moveError}
        </p>
      )}
    </div>
  );
}

function MoveButton({
  direction,
  categoryId,
  name,
  disabled,
  action,
  buttonRef,
}: {
  direction: Direction;
  categoryId: string;
  name: string;
  disabled: boolean;
  action: (formData: FormData) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const Icon = direction === "up" ? ArrowUp : ArrowDown;
  const label = `Move ${name} ${direction}`;
  if (disabled) {
    return (
      <Button ref={buttonRef} variant="ghost" disabled aria-label={label}>
        <Icon className="size-4" aria-hidden />
      </Button>
    );
  }
  return (
    <form action={action} className="inline-flex">
      <input type="hidden" name="categoryId" value={categoryId} />
      <input type="hidden" name="direction" value={direction} />
      <SubmitButton ref={buttonRef} variant="ghost" aria-label={label}>
        <Icon className="size-4" aria-hidden />
      </SubmitButton>
    </form>
  );
}

function RenameForm({ id, name, onDone }: { id: string; name: string; onDone: (message?: string) => void }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await renameCategoryAction(prev, formData);
    } catch {
      const value = formData.get("name");
      return { ok: false, message: OFFLINE_MESSAGE, values: { name: typeof value === "string" ? value : name }, nonce: Date.now() };
    }
    if (result?.ok) {
      const next = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim();
      onDone(next && next !== name ? `Renamed “${name}” to “${next}”.` : undefined);
    }
    return result;
  }, initialActionState);
  const error = state && !state.ok ? (state.fieldErrors?.name ?? state.message) : undefined;

  // Back to the field after an error, so it's read out and can be fixed right away.
  useEffect(() => {
    if (state && !state.ok) inputRef.current?.focus();
  }, [state]);

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    }
  }

  return (
    <form action={formAction} onKeyDown={onKeyDown} className="space-y-1.5" aria-label={`Rename ${name}`}>
      <input type="hidden" name="categoryId" value={id} />
      <Label htmlFor={inputId} className="wrap-anywhere">
        New name for “{name}”
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          name="name"
          required
          maxLength={LIMITS.categoryNameMax}
          defaultValue={state && !state.ok ? (state.values?.name ?? name) : name}
          autoComplete="off"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className="min-w-0 grow basis-48"
        />
        <div className="flex gap-2">
          <SubmitButton pendingText="Saving…">Save</SubmitButton>
          <Button variant="ghost" onClick={() => onDone()}>
            Cancel
          </Button>
        </div>
      </div>
      <FieldError id={`${inputId}-error`}>{error}</FieldError>
    </form>
  );
}
