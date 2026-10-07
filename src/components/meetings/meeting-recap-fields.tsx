"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { addDays, type DateOnly } from "@/lib/dates";
import type { MeetingCategoryOption } from "@/lib/meeting-recaps";
import { parseTranscriptLines } from "@/lib/meeting-recorder/transcript-format";
import { Field, Input, Textarea } from "../ui/field";
import { CategoryPicker } from "./category-picker";

/** What a recap's form fields hold (the actions read them by these names). */
export interface MeetingRecapFieldValues {
  title: string;
  /** The meeting's day, team timezone. */
  meetingDate: DateOnly;
  categoryIds: string[];
  /** One point per line, optionally starting with "[m:ss] ". */
  keyPoints: string;
  /** One line per moment, optionally starting with "[m:ss] ". */
  transcript: string;
}

export interface MeetingRecapFieldsProps {
  /**
   * Uncontrolled use (Write one up, Edit): the starting values. The fields keep their own state; read what was typed
   * from the form (`new FormData(form)`: title, meetingDate, categoryIds (repeated), keyPoints, transcript).
   */
  initial?: MeetingRecapFieldValues;
  /** Controlled use (the recorder's review step): the values to show. Pass `onChange` too. */
  values?: MeetingRecapFieldValues;
  /**
   * Every change, as the fields that changed. Merge it with a functional update — `setDraft((d) => ({ ...d, ...patch
   * }))` — since a category added inline is picked when its save comes back, after other typing maybe.
   */
  onChange?: (patch: Partial<MeetingRecapFieldValues>) => void;
  /** The team's meeting categories. */
  categories: MeetingCategoryOption[];
  /** The team's today: the date picker offers 5 years back to tomorrow (what the server accepts). */
  today: DateOnly;
  /** The action's per-field messages (ActionState.fieldErrors: title, meetingDate, categoryIds, keyPoints, transcript). */
  errors?: Record<string, string>;
  /** Offer "New category…" (default true). */
  canAddCategory?: boolean;
  /** Controls shown with the key points (e.g. the edit page's "Suggest key points"). */
  keyPointsActions?: ReactNode;
  /** Controls shown with the transcript (e.g. "Transcribe the recording again"). */
  transcriptActions?: ReactNode;
  /** Start with the transcript's box open (default: only when the transcript is short, or has an error). */
  transcriptOpen?: boolean;
  /** Prefix of the fields' element ids (default "recap"), if two sets could share a page. */
  idPrefix?: string;
  disabled?: boolean;
}

/** A transcript longer than this many lines starts folded (it can be thousands). */
const OPEN_TRANSCRIPT_LINES = 12;

const EMPTY: MeetingRecapFieldValues = { title: "", meetingDate: "", categoryIds: [], keyPoints: "", transcript: "" };

/**
 * A meeting recap's fields: title, meeting date, categories (CategoryPicker, with "New category…"), key points, and the
 * transcript (folded behind a button when long; it's still sent with the form while folded). Shared by Write one up,
 * Edit (MeetingRecapForm), and the recorder's review step. Every control has its form `name`, and the fields mark
 * themselves invalid (`aria-invalid` / `data-invalid`), so useFocusFirstError finds the first one to fix.
 *
 * Inside a `<form>`, submit it without React's automatic form reset (`onSubmit` → `preventDefault()` →
 * `startTransition(() => formAction(new FormData(form)))`, like the task form): a reset would put the category boxes
 * back while the state still holds the picks.
 */
export function MeetingRecapFields({
  initial,
  values,
  onChange,
  categories,
  today,
  errors = {},
  canAddCategory = true,
  keyPointsActions,
  transcriptActions,
  transcriptOpen,
  idPrefix = "recap",
  disabled = false,
}: MeetingRecapFieldsProps) {
  const [own, setOwn] = useState<MeetingRecapFieldValues>(initial ?? EMPTY);
  const current = values ?? own;
  const [open, setOpen] = useState(() => transcriptOpen ?? parseTranscriptLines(current.transcript).length <= OPEN_TRANSCRIPT_LINES);
  // An error on the transcript opens it, so it can be seen and focused.
  const showTranscript = open || !!errors.transcript;
  const lineCount = useMemo(() => parseTranscriptLines(current.transcript).length, [current.transcript]);

  function update(patch: Partial<MeetingRecapFieldValues>) {
    if (!values) setOwn((v) => ({ ...v, ...patch }));
    onChange?.(patch);
  }

  const fieldId = (key: string) => `${idPrefix}-${key}`;
  const described = (key: string) => (errors[key] ? `${fieldId(key)}-error` : undefined);
  const minDate = `${Number(today.slice(0, 4)) - 5}${today.slice(4)}`;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <Field label="Title" htmlFor={fieldId("title")} error={errors.title}>
          <Input
            id={fieldId("title")}
            name="title"
            required
            maxLength={LIMITS.meetingTitleMax}
            value={current.title}
            onChange={(e) => update({ title: e.currentTarget.value })}
            invalid={!!errors.title}
            aria-describedby={described("title")}
            placeholder="e.g. Build meeting: intake design"
            autoComplete="off"
            disabled={disabled}
          />
        </Field>
        <Field label="Meeting date" htmlFor={fieldId("meetingDate")} error={errors.meetingDate}>
          <Input
            id={fieldId("meetingDate")}
            name="meetingDate"
            type="date"
            required
            min={minDate}
            max={addDays(today, 1)}
            value={current.meetingDate}
            onChange={(e) => update({ meetingDate: e.currentTarget.value })}
            invalid={!!errors.meetingDate}
            aria-describedby={described("meetingDate")}
            disabled={disabled}
          />
        </Field>
      </div>

      <CategoryPicker
        categories={categories}
        selected={current.categoryIds}
        onChange={(categoryIds) => update({ categoryIds })}
        error={errors.categoryIds}
        canAdd={canAddCategory}
        disabled={disabled}
      />

      <div className="space-y-1.5">
        <Field
          label="Key points"
          htmlFor={fieldId("keyPoints")}
          error={errors.keyPoints}
          hint="One point per line. Start a line with [12:30] to link it to that moment."
        >
          <Textarea
            id={fieldId("keyPoints")}
            name="keyPoints"
            rows={8}
            maxLength={LIMITS.meetingKeyPointsMax}
            value={current.keyPoints}
            onChange={(e) => update({ keyPoints: e.currentTarget.value })}
            invalid={!!errors.keyPoints}
            aria-describedby={described("keyPoints")}
            placeholder={"[12:30] Decision: we go with the 4-bar intake.\n[31:05] To do (Alice, by Friday): order the 312 RPM motors."}
            disabled={disabled}
          />
        </Field>
        {keyPointsActions && <div className="flex flex-wrap gap-2">{keyPointsActions}</div>}
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <label htmlFor={fieldId("transcript")} className="text-sm font-medium text-ink-800">
            Transcript <span className="font-normal text-ink-500">(optional)</span>
          </label>
          <button
            type="button"
            aria-expanded={showTranscript}
            aria-controls={`${fieldId("transcript")}-box`}
            onClick={() => setOpen((v) => !v)}
            disabled={!!errors.transcript}
            className="-mr-2 inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800 disabled:opacity-60"
          >
            {showTranscript ? "Hide" : lineCount > 0 ? `Show (${lineCount.toLocaleString("en-US")} lines)` : "Add one"}
            <ChevronDown className={cn("size-4 transition-transform", showTranscript && "rotate-180")} aria-hidden />
          </button>
        </div>
        {/* Folded, the box is only hidden: it's still sent with the form. */}
        <div id={`${fieldId("transcript")}-box`} className={cn("space-y-1.5", !showTranscript && "hidden")}>
          <Textarea
            id={fieldId("transcript")}
            name="transcript"
            rows={12}
            maxLength={LIMITS.meetingTranscriptMax}
            value={current.transcript}
            onChange={(e) => update({ transcript: e.currentTarget.value })}
            invalid={!!errors.transcript}
            aria-describedby={errors.transcript ? `${fieldId("transcript")}-error` : `${fieldId("transcript")}-hint`}
            placeholder={"[0:04] Okay, let's get started.\n[1:12] For the intake, the 4-bar won the vote."}
            className="font-mono text-xs leading-relaxed sm:text-sm"
            disabled={disabled}
          />
          {!errors.transcript && (
            <p id={`${fieldId("transcript")}-hint`} className="text-xs text-ink-500">
              One line per moment, starting with its time like the key points. Everyone can read it, and the list&apos;s search looks in it
              too.
            </p>
          )}
        </div>
        {errors.transcript && (
          <p id={`${fieldId("transcript")}-error`} className="text-sm text-red-600">
            {errors.transcript}
          </p>
        )}
        {transcriptActions && <div className="flex flex-wrap gap-2">{transcriptActions}</div>}
      </div>
    </div>
  );
}
