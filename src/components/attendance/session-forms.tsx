"use client";

import { CirclePlay, CircleStop, LoaderCircle, Trash2 } from "lucide-react";
import { type FormEvent, startTransition, useActionState, useEffect, useRef, useState } from "react";
import {
  closeSessionAction,
  deleteSessionAction,
  reopenSessionAction,
  setDayPlanAction,
  setSessionNoteAction,
  startAttendanceAction,
} from "@/app/(app)/attendance/actions";
import type { AttendanceKind } from "@/generated/prisma/enums";
import { initialActionState } from "@/lib/action-state";
import { ATTENDANCE_KIND_LABELS } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import type { DateOnly } from "@/lib/dates";
import { Button, type ButtonVariant } from "../ui/button";
import { Field, Textarea } from "../ui/field";
import { FormMessage } from "../ui/form-message";
import { SubmitButton } from "../ui/submit-button";

/**
 * "Start Regular" / "Reopen Flex": opens (or reopens) today's session and goes to its live screen. `confirm` asks
 * first (e.g. on a day without that kind of practice).
 */
export function StartAttendanceButton({
  kind,
  label,
  variant = "primary",
  confirm,
  className,
}: {
  kind: AttendanceKind;
  label: string;
  variant?: ButtonVariant;
  confirm?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState(startAttendanceAction, initialActionState);
  return (
    <form action={formAction} className={cn("inline-flex flex-col", className)}>
      <input type="hidden" name="kind" value={kind} />
      <SubmitButton variant={variant} pendingText="Starting…" confirm={confirm}>
        <CirclePlay className="size-4" aria-hidden />
        {label}
      </SubmitButton>
      {state && !state.ok && (
        <p role="alert" className="mt-1 max-w-64 text-xs text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}

/**
 * Close attendance (stop check-ins) or, once it's closed and still today, reopen it. Both stay on the page, so
 * focus moves to the other button and a status line says what happened.
 */
export function SessionOpenButtons({ sessionId, kind, open, canReopen }: { sessionId: string; kind: AttendanceKind; open: boolean; canReopen: boolean }) {
  const [closeState, closeAction] = useActionState(closeSessionAction, initialActionState);
  const [reopenState, reopenAction] = useActionState(reopenSessionAction, initialActionState);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const closedNonce = closeState?.ok ? (closeState.nonce ?? 0) : 0;
  const reopenedNonce = reopenState?.ok ? (reopenState.nonce ?? 0) : 0;
  useEffect(() => {
    if (closedNonce) (reopenRef.current ?? statusRef.current)?.focus();
  }, [closedNonce]);
  useEffect(() => {
    if (reopenedNonce) (closeRef.current ?? statusRef.current)?.focus();
  }, [reopenedNonce]);
  const latest = (closeState?.nonce ?? 0) >= (reopenState?.nonce ?? 0) ? closeState : reopenState;
  const error = latest && !latest.ok ? latest.message : "";
  // Only say what happened while it's still true (the other runner may have switched it back since).
  const status = latest?.ok && (latest === closeState ? !open : open) ? latest.message : "";
  const label = ATTENDANCE_KIND_LABELS[kind];

  return (
    <div className="flex flex-col items-start gap-1">
      {open ? (
        <form action={closeAction}>
          <input type="hidden" name="sessionId" value={sessionId} />
          <SubmitButton
            ref={closeRef}
            variant="danger"
            pendingText="Closing…"
            confirm={`Close ${label} attendance? People can't check in after this (you can still add them by hand).`}
          >
            <CircleStop className="size-4" aria-hidden />
            Close attendance
          </SubmitButton>
        </form>
      ) : (
        canReopen && (
          <form action={reopenAction}>
            <input type="hidden" name="kind" value={kind} />
            <SubmitButton ref={reopenRef} variant="secondary" pendingText="Reopening…">
              <CirclePlay className="size-4" aria-hidden />
              Reopen {label}
            </SubmitButton>
          </form>
        )
      )}
      {error && (
        <p role="alert" className="max-w-64 text-xs text-red-600">
          {error}
        </p>
      )}
      <p ref={statusRef} role="status" tabIndex={-1} className="max-w-64 text-xs text-brand-700 focus:outline-none">
        {status}
      </p>
    </div>
  );
}

/** Delete a session started by mistake (asks first); the service decides whether it still can be. */
export function DeleteSessionButton({ sessionId, kind, dayLabel }: { sessionId: string; kind: AttendanceKind; dayLabel: string }) {
  const [state, formAction] = useActionState(deleteSessionAction, initialActionState);
  const label = ATTENDANCE_KIND_LABELS[kind];
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="sessionId" value={sessionId} />
      <SubmitButton
        variant="secondary"
        className="text-red-700"
        pendingText="Deleting…"
        confirm={`Delete ${label} attendance for ${dayLabel}? Everyone comes off its list, and it won't count in the reports.`}
      >
        <Trash2 className="size-4" aria-hidden />
        Delete this attendance
      </SubmitButton>
      {state && !state.ok && (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Same text, ignoring how line breaks came back (forms send CRLF) and outer spaces. */
function sameText(a: string, b: string) {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();
  return norm(a) === norm(b);
}

/**
 * A textarea + Save for text several people may edit at once ("What we did", a day's plan). It sends back the
 * saved text the edit started from (`base`), so a save never silently replaces what someone else saved meanwhile:
 * their text shows under the box (with "Use theirs"), and saving again replaces it on purpose. While nobody is
 * typing here, the box follows the saved text as the page refreshes. Keeps what was typed after an error (and
 * focuses it), and says when it's saved. Submitted without React's form reset, so the typing is never lost.
 */
function NoteForm({
  action,
  hidden,
  name,
  label,
  hint,
  initial,
  max,
  placeholder,
  button,
}: {
  action: typeof setSessionNoteAction;
  hidden: Record<string, string>;
  name: string;
  label: string;
  hint?: string;
  initial: string;
  max: number;
  placeholder?: string;
  button: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  const [text, setText] = useState(initial);
  const [base, setBase] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [handled, setHandled] = useState(state?.nonce);
  const [theirs, setTheirs] = useState<string | null>(null);
  // The saved text changed (this save, someone else's, a refresh): follow it unless someone is mid-edit here.
  if (initial !== seen) {
    setSeen(initial);
    if (sameText(text, base) || sameText(text, initial)) {
      setText(initial);
      setBase(initial);
      setTheirs(null);
    }
  }
  // A save was refused because someone else saved first: show theirs; saving again replaces it on purpose.
  if (state?.nonce !== handled) {
    setHandled(state?.nonce);
    if (state && !state.ok && !sameText(initial, base)) {
      setTheirs(initial);
      setBase(initial);
    }
  }
  const other = theirs ?? (sameText(initial, base) ? null : initial);

  const ref = useRef<HTMLTextAreaElement>(null);
  const error = state && !state.ok ? (state.fieldErrors?.[name] ?? state.fieldErrors?.date) : undefined;
  useEffect(() => {
    if (state && !state.ok) ref.current?.focus();
  }, [state]);
  const fieldId = `${name}-${Object.values(hidden).join("-")}`;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const formData = new FormData(e.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="base" value={base} />
      <Field label={label} htmlFor={fieldId} hint={hint} error={error}>
        <Textarea
          ref={ref}
          id={fieldId}
          name={name}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          maxLength={max}
          placeholder={placeholder}
          invalid={!!error}
          aria-describedby={error ? `${fieldId}-error` : undefined}
        />
      </Field>
      {other !== null && !sameText(other, text) && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <p className="font-medium">Someone else saved this meanwhile:</p>
          <p className="whitespace-pre-line wrap-anywhere">{other || <span className="italic">(empty)</span>}</p>
          <Button
            size="md"
            variant="secondary"
            onClick={() => {
              setText(other);
              setBase(initial);
              setTheirs(null);
              ref.current?.focus();
            }}
          >
            Use theirs
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          aria-disabled={pending || undefined}
          aria-busy={pending}
          className={cn(pending && "cursor-wait opacity-60")}
        >
          {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          {pending ? "Saving…" : button}
        </Button>
      </div>
      {state && !state.ok && !error ? <FormMessage state={state} /> : null}
      <p role="status" className="text-sm font-medium text-brand-700">
        {state?.ok ? state.message : ""}
      </p>
    </form>
  );
}

export function SessionNoteForm({ sessionId, note }: { sessionId: string; note: string }) {
  return (
    <NoteForm
      action={setSessionNoteAction}
      hidden={{ sessionId }}
      name="note"
      label="A line or two for the two-week report"
      initial={note}
      max={LIMITS.attendanceNoteMax}
      placeholder="e.g. Drive practice, tuned the intake, CAD for the new arm"
      button="Save"
    />
  );
}

export function DayPlanForm({ date, plan }: { date: DateOnly; plan: string }) {
  return (
    <NoteForm
      action={setDayPlanAction}
      hidden={{ date }}
      name="plan"
      label="Plan for the day"
      hint="Everyone sees it next to their answer. Leave empty to remove it."
      initial={plan}
      max={LIMITS.attendancePlanMax}
      placeholder="e.g. Build: finish the intake. Software: auto paths. Business: sponsor calls."
      button="Save plan"
    />
  );
}
