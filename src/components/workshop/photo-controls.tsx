"use client";

import { ArrowDown, ArrowUp, ImageUp, Pencil, Trash2 } from "lucide-react";
import { useActionState, useId, useRef, useState } from "react";
import {
  moveWorkshopPhotoAction,
  removeWorkshopPhotoAction,
  setWorkshopCoverAction,
  updateWorkshopPhotoAction,
} from "@/app/(app)/workshop/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { WORKSHOP_LIMITS } from "@/lib/workshop";
import { Button } from "../ui/button";
import { Field, Input, Textarea } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";
import { WorkshopActionButton } from "./action-button";

/**
 * What the people who can change a project do with one photo: move it earlier or later in the story, make it the
 * cover, edit its caption (label and note, in a panel that opens here), or remove it (not the only photo of a project
 * on the website or waiting for approval: `canRemove` false, and a hint says why).
 */
export function WorkshopPhotoControls({
  photoId,
  name,
  label,
  note,
  isCover,
  isFirst,
  isLast,
  canRemove,
}: {
  photoId: string;
  /** How buttons name it: its label, or "photo 2". */
  name: string;
  label: string;
  note: string;
  isCover: boolean;
  isFirst: boolean;
  isLast: boolean;
  canRemove: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState("");
  const panelId = useId();
  const keepHintId = `${panelId}-keep`;
  const toggleRef = useRef<HTMLButtonElement>(null);

  function close(message = "") {
    setEditing(false);
    setSaved(message);
    requestAnimationFrame(() => toggleRef.current?.focus());
  }

  return (
    <div className="space-y-2">
      <div data-focus-group className="flex flex-wrap items-start gap-2">
        <WorkshopActionButton
          action={moveWorkshopPhotoAction}
          fields={{ photoId, direction: "up" }}
          size="icon"
          disabled={isFirst}
          aria-label={`Move ${name} earlier`}
        >
          <ArrowUp className="size-4" aria-hidden />
        </WorkshopActionButton>
        <WorkshopActionButton
          action={moveWorkshopPhotoAction}
          fields={{ photoId, direction: "down" }}
          size="icon"
          disabled={isLast}
          aria-label={`Move ${name} later`}
        >
          <ArrowDown className="size-4" aria-hidden />
        </WorkshopActionButton>
        {!isCover && (
          <WorkshopActionButton
            action={setWorkshopCoverAction}
            fields={{ photoId }}
            buttonClassName="px-3"
            pendingText="Saving…"
            aria-label={`Make cover: ${name}`}
          >
            <ImageUp className="size-4" aria-hidden />
            Make cover
          </WorkshopActionButton>
        )}
        <Button
          ref={toggleRef}
          variant="secondary"
          className="px-3"
          aria-expanded={editing}
          aria-controls={editing ? panelId : undefined}
          aria-label={`Edit caption of ${name}`}
          onClick={() => {
            if (editing) return close();
            setEditing(true);
            setSaved("");
          }}
        >
          <Pencil className="size-4" aria-hidden />
          Edit caption
        </Button>
        <WorkshopActionButton
          action={removeWorkshopPhotoAction}
          fields={{ photoId }}
          variant="ghost"
          buttonClassName="px-3"
          confirm={`Remove ${name}? This can't be undone.`}
          pendingText="Removing…"
          disabled={!canRemove}
          aria-label={`Remove ${name}`}
          aria-describedby={canRemove ? undefined : keepHintId}
        >
          <Trash2 className="size-4" aria-hidden />
          Remove
        </WorkshopActionButton>
      </div>
      {!canRemove && (
        <p id={keepHintId} className="text-xs text-ink-500">
          A project on the team website or waiting for approval needs a photo. Add another one first.
        </p>
      )}
      {editing && <CaptionForm id={panelId} photoId={photoId} label={label} note={note} onDone={close} />}
      <p role="status" className="text-sm font-medium text-brand-700 empty:hidden">
        {saved}
      </p>
    </div>
  );
}

function CaptionForm({
  id,
  photoId,
  label,
  note,
  onDone,
}: {
  id: string;
  photoId: string;
  label: string;
  note: string;
  onDone: (message?: string) => void;
}) {
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const result = await updateWorkshopPhotoAction(prev, formData);
    if (result?.ok) onDone(result.message);
    return result;
  }, initialActionState);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const labelId = `${id}-label`;
  const noteId = `${id}-note`;

  return (
    <form
      id={id}
      action={formAction}
      className="space-y-3 rounded-lg border border-ink-200 bg-ink-50 p-3"
      noValidate
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    >
      <input type="hidden" name="photoId" value={photoId} />
      <div key={state?.nonce ?? 0} className="space-y-3">
        <Field label="Label" htmlFor={labelId} error={errors.label} optional>
          <Input
            id={labelId}
            name="label"
            maxLength={WORKSHOP_LIMITS.photoLabelMax}
            defaultValue={(state && !state.ok ? state.values?.label : undefined) ?? label}
            invalid={!!errors.label}
            aria-describedby={errors.label ? `${labelId}-error` : undefined}
            placeholder="Version 1"
            autoComplete="off"
            autoFocus
          />
        </Field>
        <Field label="Note" htmlFor={noteId} error={errors.note} optional>
          <Textarea
            id={noteId}
            name="note"
            rows={3}
            maxLength={WORKSHOP_LIMITS.photoNoteMax}
            defaultValue={(state && !state.ok ? state.values?.note : undefined) ?? note}
            invalid={!!errors.note}
            aria-describedby={errors.note ? `${noteId}-error` : undefined}
            placeholder="What changed, or what failed and why"
          />
        </Field>
      </div>
      {state && !state.ok && !state.fieldErrors && state.message && (
        <p role="alert" className="text-sm text-red-600 wrap-anywhere">
          {state.message}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <SubmitButton pendingText="Saving…" className="w-full sm:w-auto">
          Save caption
        </SubmitButton>
        <Button variant="ghost" className="w-full sm:w-auto" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
