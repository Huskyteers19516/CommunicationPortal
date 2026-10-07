"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { type KeyboardEvent, type RefObject, useActionState, useEffect, useId, useRef, useState } from "react";
import {
  createMeetingCategoryAction,
  deleteMeetingCategoryAction,
  type MeetingCategoryCreateState,
  renameMeetingCategoryAction,
} from "@/app/(app)/meetings/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";
import { MEETING_CATEGORIES_MAX } from "@/lib/meeting-recaps";
import type { MeetingCategoryRow } from "@/server/queries/meeting-recaps";
import { ActionForm } from "../tasks/action-form";
import { Button } from "../ui/button";
import { CardBody } from "../ui/card";
import { FieldError, Input, Label } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";
/** How long a confirmation ("Added “Drive team”.") stays on screen. */
const MESSAGE_MS = 6000;

function recapsLabel(n: number): string {
  return n === 0 ? "No recaps" : `${n.toLocaleString("en-US")} ${n === 1 ? "recap" : "recaps"}`;
}

/**
 * The team's meeting categories on /meetings/categories: rename inline, delete (the confirm says how many recaps lose
 * it), and add. Owns the status line (the latest change) and moves focus on after a delete — to the next row's
 * "Rename", or to the add field when the last row went. Alphabetical, like everywhere they show.
 */
export function MeetingCategoryList({ categories }: { categories: MeetingCategoryRow[] }) {
  const [message, setMessage] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const focusAfterDelete = useRef<{ id: string; index: number } | null>(null);
  const full = categories.length >= MEETING_CATEGORIES_MAX;

  // A newer change replaces the message; otherwise it clears itself so it can't go stale.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const pending = focusAfterDelete.current;
    if (!pending || categories.some((c) => c.id === pending.id)) return;
    focusAfterDelete.current = null;
    const renameButtons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-rename]");
    (renameButtons?.[pending.index] ?? addInputRef.current)?.focus();
  }, [categories]);

  return (
    <>
      {categories.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-500 sm:px-5">No categories yet. Add the kinds of meetings the team has.</p>
      ) : (
        <ul ref={listRef} className="divide-y divide-ink-100" aria-label="Meeting categories">
          {categories.map((category, i) => (
            <li key={category.id} className="px-4 py-2 sm:px-5">
              <CategoryRow
                category={category}
                onMessage={setMessage}
                onDeleted={(text) => {
                  focusAfterDelete.current = { id: category.id, index: i };
                  setMessage(text);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <CardBody className="border-t border-ink-100">
        {full ? (
          <p className="text-sm text-ink-500">
            That&apos;s {MEETING_CATEGORIES_MAX} categories, the most the list can have. Delete one to add another.
          </p>
        ) : (
          <AddForm inputRef={addInputRef} onAdded={setMessage} />
        )}
        {/* Always rendered so screen readers announce each change. */}
        <p role="status" className="mt-1.5 text-sm text-brand-700 empty:mt-0">
          {message}
        </p>
      </CardBody>
    </>
  );
}

/** One category: its name and how many recaps have it, Rename (inline), and Delete. */
function CategoryRow({
  category,
  onMessage,
  onDeleted,
}: {
  category: MeetingCategoryRow;
  onMessage: (message: string) => void;
  /** Called once it's gone (before the list draws again without it). */
  onDeleted: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const { id, name, recapCount } = category;

  async function deleteAction(prev: ActionState, formData: FormData): Promise<ActionState> {
    const result = await deleteMeetingCategoryAction(prev, formData);
    if (result?.ok) onDeleted(result.message ?? `Deleted “${name}”.`);
    return result;
  }

  function closeRename(text?: string) {
    setRenaming(false);
    if (text) onMessage(text);
    // The button is back after this render; focus it on the next frame.
    requestAnimationFrame(() => renameButtonRef.current?.focus());
  }

  if (renaming) return <RenameForm id={id} name={name} onDone={closeRename} />;

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 grow basis-0">
        <p className="text-sm font-medium text-ink-900 wrap-anywhere">{name}</p>
        <p className="text-xs text-ink-500">{recapsLabel(recapCount)}</p>
      </div>
      <div className="-mr-2 flex shrink-0 items-center">
        <Button ref={renameButtonRef} data-rename="" variant="ghost" onClick={() => setRenaming(true)} aria-label={`Rename ${name}`}>
          <Pencil className="size-4" aria-hidden />
          <span className="hidden sm:inline">Rename</span>
        </Button>
        <ActionForm
          action={deleteAction}
          fields={{ categoryId: id }}
          variant="ghost"
          pendingText="Deleting…"
          confirm={
            recapCount > 0
              ? `Delete “${name}”? It comes off ${recapCount === 1 ? "the 1 recap" : `the ${recapCount} recaps`} that have it (the recaps stay).`
              : `Delete “${name}”?`
          }
          aria-label={`Delete ${name}`}
        >
          <Trash2 className="size-4 text-red-600" aria-hidden />
          <span className="hidden sm:inline">Delete</span>
        </ActionForm>
      </div>
    </div>
  );
}

function RenameForm({ id, name, onDone }: { id: string; name: string; onDone: (message?: string) => void }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await renameMeetingCategoryAction(prev, formData);
    } catch {
      const value = formData.get("name");
      return { ok: false, message: OFFLINE_MESSAGE, values: { name: typeof value === "string" ? value : name }, nonce: Date.now() };
    }
    // "Renamed to “X”." (or "That's its name already.") goes to the list's status line.
    if (result?.ok) onDone(result.message);
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

/** Add a category (stays open, ready for the next name). */
function AddForm({ inputRef, onAdded }: { inputRef: RefObject<HTMLInputElement | null>; onAdded: (message: string) => void }) {
  const inputId = useId();
  const [state, formAction] = useActionState(
    async (prev: MeetingCategoryCreateState, formData: FormData): Promise<MeetingCategoryCreateState> => {
      let result: MeetingCategoryCreateState;
      try {
        result = await createMeetingCategoryAction(prev, formData);
      } catch {
        const name = formData.get("name");
        return { ok: false, message: OFFLINE_MESSAGE, values: { name: typeof name === "string" ? name : "" }, nonce: Date.now() };
      }
      if (result?.ok) onAdded(result.message ?? "Category added.");
      return result;
    },
    null,
  );
  const error = state && !state.ok ? (state.fieldErrors?.name ?? state.message) : undefined;
  const errorId = `${inputId}-error`;

  // Each result is a new object: focus goes back to the field (to fix it, or type the next name).
  useEffect(() => {
    if (state) inputRef.current?.focus();
  }, [state, inputRef]);

  return (
    <form action={formAction} className="space-y-1.5" aria-label="Add a meeting category">
      <Label htmlFor={inputId}>New category</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          name="name"
          required
          maxLength={LIMITS.categoryNameMax}
          // React resets the form after the action; keep what was typed when it failed.
          defaultValue={state && !state.ok ? (state.values?.name ?? "") : ""}
          placeholder="e.g. Drive team"
          autoComplete="off"
          invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className="min-w-40 flex-[1_1_10rem]"
        />
        <SubmitButton pendingText="Adding…" className="shrink-0">
          <Plus className="size-4" aria-hidden />
          Add
        </SubmitButton>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </form>
  );
}
