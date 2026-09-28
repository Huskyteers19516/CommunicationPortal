"use client";

import { LoaderCircle } from "lucide-react";
import { type FormEvent, startTransition, useActionState, useRef, useState } from "react";
import { updateSettingsAction } from "@/app/(app)/attendance/actions";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { initialActionState } from "@/lib/action-state";
import { type SavedAttendanceSettings, WEEKDAY_LABELS, WEEKDAYS, WEEKLY_TARGET_MAX, WEEKLY_TARGET_MIN } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { Button } from "../ui/button";
import { Field, FieldError, Input, Select } from "../ui/field";
import { FormMessage } from "../ui/form-message";

function DayBoxes({
  name,
  legend,
  hint,
  checked,
  onChange,
  error,
}: {
  name: "regularDays" | "flexDays";
  legend: string;
  hint: string;
  checked: number[];
  onChange: (days: number[]) => void;
  error?: string;
}) {
  return (
    <fieldset className="space-y-2" aria-describedby={error ? `${name}-error` : `${name}-hint`}>
      <legend className="text-sm font-medium text-ink-800">{legend}</legend>
      <p id={`${name}-hint`} className="text-xs text-ink-500">
        {hint}
      </p>
      <div className="flex flex-wrap gap-2">
        {WEEKDAYS.map((d, i) => (
          <label
            key={d}
            className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50"
          >
            <input
              type="checkbox"
              name={name}
              value={d}
              checked={checked.includes(d)}
              onChange={(e) => onChange(e.currentTarget.checked ? [...checked, d] : checked.filter((x) => x !== d))}
              className="size-4 rounded border-ink-300"
              data-invalid={error && i === 0 ? "true" : undefined}
            />
            {WEEKDAY_LABELS[d]}
          </label>
        ))}
      </div>
      <FieldError id={`${name}-error`}>{error}</FieldError>
    </fieldset>
  );
}

const TARGETS = Array.from({ length: WEEKLY_TARGET_MAX - WEEKLY_TARGET_MIN + 1 }, (_, i) => WEEKLY_TARGET_MIN + i);

/** The team's schedule: regular days, Flex days, the weekly goal, and the Monday the two-week reports count from. */
export function AttendanceSettingsForm({ settings }: { settings: SavedAttendanceSettings }) {
  const [state, formAction, pending] = useActionState(updateSettingsAction, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);
  const failed = !!state && !state.ok;
  const errors = failed ? state.fieldErrors : undefined;
  // One field's error is already shown under it (and focused): don't say it again above Save.
  const repeats = failed && !!errors && Object.values(errors).includes(state.message ?? "");
  const [regularDays, setRegularDays] = useState<number[]>(settings.regularDays);
  const [flexDays, setFlexDays] = useState<number[]>(settings.flexDays);
  const [weeklyTarget, setWeeklyTarget] = useState(String(settings.weeklyTarget));

  // Sent without React's automatic form reset (which would put the boxes back to the saved days after a
  // failed save while the state above still held the edits, so the next save would quietly send the old days).
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const formData = new FormData(e.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-6">
      <DayBoxes
        name="regularDays"
        legend="Regular meetings"
        hint="People answer Yes, Half, or No for these days. For a meeting on another day, add an extra meeting below."
        checked={regularDays}
        onChange={setRegularDays}
        error={errors?.regularDays}
      />
      <DayBoxes
        name="flexDays"
        legend="Flex"
        hint="People also answer “Attend Flex?” Yes or No."
        checked={flexDays}
        onChange={setFlexDays}
        error={errors?.flexDays}
      />
      <Field
        label="Goal: times a week"
        htmlFor="weeklyTarget"
        hint="How many practices each person should come to, Monday to Sunday. Regular, EC, and Flex all count (1/2 counts as half)."
        error={errors?.weeklyTarget}
        className="max-w-60"
      >
        <Select
          id="weeklyTarget"
          name="weeklyTarget"
          value={weeklyTarget}
          onChange={(e) => setWeeklyTarget(e.currentTarget.value)}
          invalid={!!errors?.weeklyTarget}
          aria-describedby={errors?.weeklyTarget ? "weeklyTarget-error" : undefined}
        >
          {TARGETS.map((n) => (
            <option key={n} value={n}>
              {n} a week
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Reports start"
        htmlFor="reportStart"
        hint="A Monday: the first day of the season. Two-week reports count from here, so changing it regroups past reports (none are lost)."
        error={errors?.reportStart}
        className="max-w-60"
      >
        <Input
          id="reportStart"
          name="reportStart"
          type="date"
          defaultValue={failed ? (state.values?.reportStart ?? settings.reportStart) : settings.reportStart}
          invalid={!!errors?.reportStart}
          aria-describedby={errors?.reportStart ? "reportStart-error" : undefined}
        />
      </Field>
      {!repeats && <FormMessage state={state} />}
      <Button type="submit" aria-disabled={pending || undefined} aria-busy={pending} className={cn(pending && "cursor-wait opacity-60")}>
        {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
        {pending ? "Saving…" : "Save schedule"}
      </Button>
    </form>
  );
}
