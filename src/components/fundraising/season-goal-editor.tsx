"use client";

import { Target } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { updateSeasonGoalAction } from "@/app/(app)/fundraising/actions";
import { initialActionState } from "@/lib/action-state";
import type { DateOnly } from "@/lib/dates";
import { fundraiserDateBounds, suggestedSeasonStart } from "@/lib/fundraising";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";

/**
 * Set / change / clear the season goal and the day the season started (Business team and leaders). Opens a
 * small box in place; saving closes it and puts focus back on the button, with a status line saying what
 * changed. The start is suggested (Sep 1) when none is set, so last season's money stops counting.
 */
export function SeasonGoalEditor({
  goal,
  seasonStart,
  today,
}: {
  goal: number | null;
  /** Null = not set (totals are all-time); the box then suggests Sep 1. */
  seasonStart: DateOnly | null;
  today: DateOnly;
}) {
  const [state, formAction] = useActionState(updateSeasonGoalAction, initialActionState);
  const [editing, setEditing] = useState(false);
  const [closedFor, setClosedFor] = useState<number | undefined>(undefined);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const focusNext = useRef<"toggle" | "input" | null>(null);

  // A successful save closes the box (together with the new numbers from the server)…
  if (state?.ok && state.nonce !== closedFor) {
    setClosedFor(state.nonce);
    setEditing(false);
  }
  // …and focus goes back to the button; a failed save keeps the box open and focuses the first field to fix.
  useEffect(() => {
    if (!state) return;
    if (state.ok) toggleRef.current?.focus();
    else (formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? inputRef.current)?.focus();
  }, [state]);
  useEffect(() => {
    if (focusNext.current === "input") inputRef.current?.focus();
    else if (focusNext.current === "toggle") toggleRef.current?.focus();
    focusNext.current = null;
  }, [editing]);

  const failed = !!state && !state.ok;
  const fieldErrors = failed ? (state.fieldErrors ?? {}) : {};
  const error = failed ? (fieldErrors.goal ?? (fieldErrors.seasonStart ? undefined : state.message)) : undefined;
  const startError = fieldErrors.seasonStart;
  const bounds = fundraiserDateBounds(today);
  const startValue = failed ? (state.values?.seasonStart ?? "") : (seasonStart ?? suggestedSeasonStart(today));

  const saved = !editing && state?.ok ? (state.message ?? "") : "";
  return (
    <div>
      {editing ? (
        <form ref={formRef} action={formAction} className="space-y-3 rounded-lg border border-ink-200 bg-ink-50/60 p-3" noValidate>
          <Field
            label="Season goal ($)"
            htmlFor="season-goal"
            error={error}
            hint="Whole dollars for the whole season. Leave it empty to add up each fundraiser's goal instead."
          >
            <Input
              key={state?.nonce ?? 0}
              ref={inputRef}
              id="season-goal"
              name="goal"
              inputMode="decimal"
              autoComplete="off"
              placeholder="e.g. 5,000"
              defaultValue={state && !state.ok ? (state.values?.goal ?? "") : goal === null ? "" : String(goal)}
              invalid={!!error}
              aria-describedby={error ? "season-goal-error" : undefined}
              className="sm:max-w-48"
            />
          </Field>
          <Field
            label="Season started"
            htmlFor="season-start"
            error={startError}
            optional
            hint="Fundraisers whose last day is on or after this day count toward the totals. Leave it empty to count every fundraiser."
          >
            <Input
              key={state?.nonce ?? 0}
              id="season-start"
              name="seasonStart"
              type="date"
              min={bounds.min}
              max={bounds.max}
              defaultValue={startValue}
              invalid={!!startError}
              aria-describedby={startError ? "season-start-error" : undefined}
              className="sm:max-w-48"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <SubmitButton pendingText="Saving…">Save goal</SubmitButton>
            <Button
              variant="secondary"
              onClick={() => {
                focusNext.current = "toggle";
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          ref={toggleRef}
          variant="secondary"
          onClick={() => {
            focusNext.current = "input";
            setEditing(true);
          }}
        >
          <Target className="size-4" aria-hidden />
          {goal === null ? "Set a season goal" : "Change season goal"}
        </Button>
      )}
      {/* Always rendered so screen readers announce the change. */}
      <p role="status" className={saved ? "mt-2 text-xs font-medium text-brand-700" : undefined}>
        {saved}
      </p>
    </div>
  );
}
