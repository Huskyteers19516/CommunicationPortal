"use client";

import { MessageSquareText, Pencil } from "lucide-react";
import { startTransition, useActionState, useEffect, useId, useOptimistic, useRef, useState } from "react";
import { setRsvpAction } from "@/app/(app)/attendance/actions";
import type { RsvpAnswer } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import type { DateOnly } from "@/lib/dates";
import { Button } from "../ui/button";
import { Input } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

export interface RsvpDayData {
  date: DateOnly;
  regularDay: boolean;
  flexDay: boolean;
  regular: RsvpAnswer | null;
  flex: RsvpAnswer | null;
  note: string;
}

type Field = "regular" | "flex";

const OPTION_STYLES: Record<RsvpAnswer, string> = {
  YES: "bg-brand-600 text-white shadow-sm",
  // amber-700: white text on it passes WCAG AA (amber-500 doesn't).
  HALF: "bg-amber-700 text-white shadow-sm",
  NO: "bg-ink-700 text-white shadow-sm",
};

const OPTION_LABELS: Record<RsvpAnswer, string> = { YES: "Yes", HALF: "Half", NO: "No" };

/**
 * Buttons like a segmented control: tapping one saves right away (shown before the server answers); tapping
 * the chosen one again clears it. Buttons stay enabled while saving, so focus stays put.
 */
function Segmented({
  label,
  labelId,
  options,
  value,
  onPick,
}: {
  label: string;
  labelId: string;
  options: RsvpAnswer[];
  value: RsvpAnswer | null;
  onPick: (answer: RsvpAnswer) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span id={labelId} className="w-24 shrink-0 text-sm font-medium text-ink-800">
        {label}
      </span>
      <div role="group" aria-labelledby={labelId} className="inline-flex rounded-lg border border-ink-200 bg-ink-50 p-0.5">
        {options.map((answer) => {
          const selected = value === answer;
          return (
            <button
              key={answer}
              type="button"
              aria-pressed={selected}
              onClick={() => onPick(answer)}
              className={cn(
                "h-10 min-w-16 rounded-md px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50",
                selected ? OPTION_STYLES[answer] : "text-ink-700 hover:bg-white",
              )}
            >
              {OPTION_LABELS[answer]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "Coming?" for one day: Regular Yes / Half / No and, on Flex days, "Attend Flex?" Yes / No, plus an optional
 * short note. Everything saves on its own; a status line says what was saved (or what went wrong).
 */
export function RsvpDay({ day, dayLabel }: { day: RsvpDayData; dayLabel: string }) {
  const [editingNote, setEditingNote] = useState(false);
  /** Whether the latest answer from the server was for the note box (it closes on success). */
  const lastWasNote = useRef(false);
  const [state, formAction, saving] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await setRsvpAction(prev, formData);
    lastWasNote.current = formData.has("note");
    if (lastWasNote.current && result?.ok) setEditingNote(false);
    return result;
  }, initialActionState);
  const [shown, setShown] = useOptimistic({ regular: day.regular, flex: day.flex });
  const noteButtonRef = useRef<HTMLButtonElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  function pick(field: Field, answer: RsvpAnswer) {
    const next = shown[field] === answer ? null : answer;
    const formData = new FormData();
    formData.set("date", day.date);
    formData.set(field, next ?? "");
    startTransition(() => {
      setShown({ ...shown, [field]: next });
      formAction(formData);
    });
  }

  // After the note is saved, focus goes back to its button; if it failed, back to the box.
  const lastNonce = useRef(state?.nonce);
  useEffect(() => {
    if (state?.nonce === lastNonce.current) return;
    lastNonce.current = state?.nonce;
    if (!lastWasNote.current) return;
    (state?.ok ? noteButtonRef : noteInputRef).current?.focus();
  }, [state]);

  const error = !saving && state && !state.ok ? state.message : "";
  const status = saving ? "Saving…" : error || (state?.ok ? (state.message ?? "") : "");
  const noteError = state && !state.ok ? state.fieldErrors?.note : undefined;

  return (
    <div className="space-y-2.5">
      {day.regularDay && (
        <Segmented
          label="Coming?"
          labelId={`${id}-regular`}
          options={["YES", "HALF", "NO"]}
          value={shown.regular}
          onPick={(a) => pick("regular", a)}
        />
      )}
      {day.flexDay && (
        <Segmented label="Attend Flex?" labelId={`${id}-flex`} options={["YES", "NO"]} value={shown.flex} onPick={(a) => pick("flex", a)} />
      )}

      {editingNote ? (
        <form
          action={formAction}
          className="flex flex-wrap items-start gap-2"
          noValidate
        >
          <input type="hidden" name="date" value={day.date} />
          <label htmlFor={`${id}-note`} className="sr-only">
            Note for {dayLabel}
          </label>
          <Input
            ref={noteInputRef}
            id={`${id}-note`}
            name="note"
            autoFocus
            maxLength={LIMITS.rsvpNoteMax}
            defaultValue={state && !state.ok ? (state.values?.note ?? day.note) : day.note}
            placeholder="e.g. Leaving at 5"
            invalid={!!noteError}
            className="min-w-0 flex-1 basis-48"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditingNote(false);
                requestAnimationFrame(() => noteButtonRef.current?.focus());
              }
            }}
          />
          <div className="flex gap-2">
            <SubmitButton pendingText="Saving…">Save note</SubmitButton>
            <Button
              variant="ghost"
              onClick={() => {
                setEditingNote(false);
                requestAnimationFrame(() => noteButtonRef.current?.focus());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {day.note && (
            <p className="flex min-w-0 items-start gap-1.5 text-sm text-ink-600">
              <MessageSquareText className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden />
              <span className="wrap-anywhere">{day.note}</span>
            </p>
          )}
          <button
            ref={noteButtonRef}
            type="button"
            onClick={() => setEditingNote(true)}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
            aria-label={day.note ? `Edit note for ${dayLabel}` : `Add note for ${dayLabel}`}
          >
            <Pencil className="size-3.5" aria-hidden />
            {day.note ? "Edit note" : "Add note"}
          </button>
        </div>
      )}

      <p role="status" className={cn("text-xs", error ? "text-red-600" : "text-ink-500")}>
        {status}
      </p>
    </div>
  );
}
