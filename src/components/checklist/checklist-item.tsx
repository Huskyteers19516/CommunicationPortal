"use client";

import { Check, ChevronDown, LoaderCircle, MessageCircleQuestionMark, MessageSquarePlus, PencilLine } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useActionState,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { submitAction, updateNoteAction, withdrawAction } from "@/app/(app)/today/actions";
import { CategoryBadge, DueBadge, PriorityBadge, SubteamBadge } from "@/components/app/badges";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, Label, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { RichText } from "@/components/ui/rich-text";
import { SubmitButton } from "@/components/ui/submit-button";
import type { AssignmentStatus } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { type DateOnly, DEFAULT_TEAM_TIMEZONE, formatDateTime, timeAgo } from "@/lib/dates";
import type { ChecklistItemData } from "@/server/queries/checklist";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";
const UNCHECK_CONFIRM = "Uncheck this? Your note to your leader will be removed.";

const circleStyles: Record<AssignmentStatus, string> = {
  TODO: "border-ink-300 bg-white text-transparent group-hover:border-brand-500 group-hover:bg-brand-50 group-hover:text-brand-300",
  REJECTED: "border-red-400 bg-white text-transparent group-hover:border-red-500 group-hover:bg-red-50 group-hover:text-red-300",
  SUBMITTED: "border-amber-400 bg-amber-400 text-white group-hover:border-amber-500 group-hover:bg-amber-500",
  APPROVED: "border-brand-500 bg-brand-500 text-white",
};

function checkboxLabel(status: AssignmentStatus, title: string): string {
  if (status === "APPROVED") return `Approved: ${title}`;
  if (status === "SUBMITTED") return `Waiting for review: ${title}. Tap to uncheck.`;
  return `Check off: ${title}`;
}

/**
 * One checklist item. Tapping the circle checks it off (sends it for review) or, while it is
 * still waiting for review, unchecks it (after a confirm if that would delete the member's note).
 * "Check off with a note" opens a small form so the note goes out with the leader's email.
 * Updates are optimistic; failures revert with a message.
 */
export function ChecklistItem({
  item,
  today,
  now,
  timeZone = DEFAULT_TEAM_TIMEZONE,
  showDue = true,
}: {
  item: ChecklistItemData;
  today: DateOnly;
  /** ISO timestamp from the server render, so relative times match between server and browser. */
  now: string;
  /** Team timezone (env.teamTimezone) for dates older than a week. */
  timeZone?: string;
  showDue?: boolean;
}) {
  const router = useRouter();
  const [status, setOptimisticStatus] = useOptimistic(item.status);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  /** The "Check off with a note" form (TODO / REJECTED items). The draft survives failures and Cancel. */
  const [noteCheckOffOpen, setNoteCheckOffOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const detailsId = useId();
  const checkOffFormId = useId();
  const circleRef = useRef<HTMLButtonElement>(null);
  const checkOffOpenerRef = useRef<HTMLButtonElement>(null);
  const checkOffFormRef = useRef<HTMLFormElement>(null);

  const { task } = item;
  const checked = status === "SUBMITTED" || status === "APPROVED";
  const approved = status === "APPROVED";
  /** Still up to the member (not waiting on a leader, not done) — only these can be "overdue". */
  const onMyPlate = status === "TODO" || status === "REJECTED";
  /** Stays up while its own check-off is in flight, so keyboard focus isn't dropped mid-request. */
  const showCheckOffForm = noteCheckOffOpen && (onMyPlate || pending);
  const nowDate = new Date(now);

  /** Run a check/uncheck with an optimistic status; on failure show why and pull fresh data. */
  function run(next: AssignmentStatus, call: () => Promise<ActionState>, onSuccess?: () => void) {
    setError(null);
    startTransition(async () => {
      setOptimisticStatus(next);
      let result: ActionState;
      try {
        result = await call();
      } catch {
        result = { ok: false, message: OFFLINE_MESSAGE };
      }
      if (result?.ok) {
        onSuccess?.();
      } else {
        setError(result?.message ?? OFFLINE_MESSAGE);
        // Someone may have reviewed it in the meantime — pull fresh data.
        router.refresh();
      }
    });
  }

  /** Check off; `note` (from the note form) is sent along and ends up in the leader's email. */
  function checkOff(note?: string) {
    let formData: FormData | undefined;
    if (note !== undefined) {
      formData = new FormData();
      formData.set("note", note);
    }
    run(
      "SUBMITTED",
      () => submitAction(item.assignmentId, null, formData),
      () => {
        if (note === undefined) return;
        // The form is about to disappear: if focus was in it (or dropped to <body> when its button
        // disabled itself), put it on the now-checked circle so keyboard users keep their place.
        const active = document.activeElement;
        if (!active || active === document.body || checkOffFormRef.current?.contains(active)) circleRef.current?.focus();
        setNoteCheckOffOpen(false);
        setNoteDraft("");
      },
    );
  }

  function toggle() {
    if (approved || pending) return;
    if (status === "SUBMITTED") {
      // Unchecking deletes the member's note — don't let one stray tap do that silently.
      if (item.submissionNote && !window.confirm(UNCHECK_CONFIRM)) return;
      setEditingNote(false);
      run("TODO", () => withdrawAction(item.assignmentId));
    } else {
      // With the note form open, a tap on the circle sends what they typed instead of dropping it.
      checkOff(showCheckOffForm ? noteDraft : undefined);
    }
  }

  function submitCheckOffForm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    checkOff(noteDraft);
  }

  function closeCheckOffForm() {
    setNoteCheckOffOpen(false);
    checkOffOpenerRef.current?.focus();
  }

  function checkOffFormKeys(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (pending) return;
      closeCheckOffForm();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.requestSubmit();
    }
  }

  // No "·" separators: in a wrapping row they end up starting or ending a line. The gap separates parts.
  const meta: ReactNode[] = [];
  if (status === "APPROVED") {
    meta.push(<span className="font-medium text-brand-700">Approved by {item.reviewerName ?? "a leader"}</span>);
    if (item.reviewedAt) meta.push(<Ago iso={item.reviewedAt} now={nowDate} timeZone={timeZone} />);
  } else if (status === "SUBMITTED") {
    meta.push(<span className="font-medium text-amber-700">Waiting for review</span>);
    if (item.status === "SUBMITTED" && item.submittedAt) {
      meta.push(<Ago iso={item.submittedAt} now={nowDate} timeZone={timeZone} prefix="checked" />);
    }
  } else if (status === "REJECTED") {
    meta.push(<span className="font-medium text-red-700">Needs changes</span>);
  }
  meta.push(<span>from {task.creatorName}</span>);

  const showSubmissionNote = status !== "TODO" && !!item.submissionNote;
  const showEarlierNote = status !== "REJECTED" && !!item.reviewNote;

  return (
    <div
      className={cn(
        "rounded-xl border p-3 shadow-sm sm:p-4",
        status === "REJECTED" ? "border-red-200 border-l-4 border-l-red-500" : "border-ink-200",
        approved ? "bg-ink-50/70" : "bg-white",
      )}
    >
      <div className="flex items-start gap-2 sm:gap-3">
        <button
          ref={circleRef}
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={checkboxLabel(status, task.title)}
          aria-busy={pending || undefined}
          disabled={approved}
          onClick={toggle}
          className="group -ml-1 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-full disabled:cursor-default"
        >
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-full border-2 transition-colors",
              circleStyles[status],
              pending && "animate-pulse",
            )}
          >
            <Check className="size-4" strokeWidth={3} aria-hidden />
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "font-medium leading-snug wrap-anywhere",
              approved ? "text-ink-500 line-through decoration-ink-300" : "text-ink-900",
            )}
          >
            {task.title}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <SubteamBadge subteam={task.subteam} />
            <CategoryBadge name={task.categoryName} />
            <PriorityBadge priority={task.priority} />
            {showDue && <DueBadge due={task.dueDate} today={today} done={!onMyPlate} />}
          </div>

          <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500">
            {meta.map((part, i) => (
              <span key={i} className="min-w-0 break-words">
                {part}
              </span>
            ))}
          </p>

          {status === "REJECTED" && item.reviewNote && (
            <Alert tone="error" title="Leader feedback" className="mt-3">
              <RichText text={item.reviewNote} />
              {item.reviewerName && <p className="mt-1 text-xs text-red-700">— {item.reviewerName}</p>}
            </Alert>
          )}

          {error && (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          )}

          <div className="-ml-2 mt-1 flex flex-wrap items-center">
            <button
              type="button"
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              onClick={() => setDetailsOpen((open) => !open)}
              className="inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
            >
              Details
              <ChevronDown className={cn("size-4 transition-transform", detailsOpen && "rotate-180")} aria-hidden />
            </button>
            {(onMyPlate || showCheckOffForm) && (
              <button
                ref={checkOffOpenerRef}
                type="button"
                aria-expanded={showCheckOffForm}
                aria-controls={showCheckOffForm ? checkOffFormId : undefined}
                disabled={pending}
                onClick={() => (showCheckOffForm ? closeCheckOffForm() : setNoteCheckOffOpen(true))}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800 disabled:opacity-60"
              >
                <MessageSquarePlus className="size-4" aria-hidden />
                Check off with a note
              </button>
            )}
            {status === "SUBMITTED" && !editingNote && !showCheckOffForm && (
              <button
                type="button"
                onClick={() => setEditingNote(true)}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800"
              >
                <PencilLine className="size-4" aria-hidden />
                {item.submissionNote ? "Edit note" : "Add a note for your leader"}
              </button>
            )}
          </div>

          {showCheckOffForm && (
            <form
              ref={checkOffFormRef}
              id={checkOffFormId}
              aria-label={`Check off ${task.title} with a note`}
              onSubmit={submitCheckOffForm}
              onKeyDown={checkOffFormKeys}
              className="mb-2 mt-1 space-y-2"
            >
              <Field
                label="Note for your leader"
                htmlFor={`${checkOffFormId}-note`}
                hint="Sent with the check-off, so your leader sees it in the email too."
              >
                <Textarea
                  id={`${checkOffFormId}-note`}
                  name="note"
                  rows={3}
                  maxLength={LIMITS.noteMax}
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="What did you do? Add links or where to find it."
                  autoFocus
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
                  {pending ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Check className="size-4" strokeWidth={3} aria-hidden />
                  )}
                  {pending ? "Checking off…" : "Check off"}
                </Button>
                <Button variant="ghost" onClick={closeCheckOffForm} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {status === "SUBMITTED" && editingNote && (
            <NoteForm
              assignmentId={item.assignmentId}
              initial={item.submissionNote ?? ""}
              onCancel={() => setEditingNote(false)}
              onSaved={() => {
                setEditingNote(false);
                setDetailsOpen(true);
              }}
              onFailed={() => router.refresh()}
            />
          )}

          <div id={detailsId} hidden={!detailsOpen} className="mt-1 space-y-3 rounded-lg bg-ink-50 p-3 text-sm">
            {task.description ? (
              <RichText text={task.description} className="text-ink-800" />
            ) : (
              <p className="text-ink-500">No description.</p>
            )}
            {showEarlierNote && item.reviewNote && (
              <NoteBlock label={status === "APPROVED" ? `Note from ${item.reviewerName ?? "your leader"}` : "Earlier feedback"}>
                <RichText text={item.reviewNote} className="text-ink-800" />
              </NoteBlock>
            )}
            {showSubmissionNote && item.submissionNote && (
              <NoteBlock label="Your note">
                <RichText text={item.submissionNote} className="text-ink-800" />
              </NoteBlock>
            )}
            <Link
              href={`/questions/new?taskId=${encodeURIComponent(task.id)}`}
              className="-ml-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800"
            >
              <MessageCircleQuestionMark className="size-4" aria-hidden />
              Ask a question about this
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "checked 3 h ago" as one unbreakable chunk; hover shows the exact time in the team timezone. */
function Ago({ iso, now, timeZone, prefix }: { iso: string; now: Date; timeZone: string; prefix?: string }) {
  const at = new Date(iso);
  return (
    <time dateTime={iso} title={formatDateTime(at, timeZone)} className="whitespace-nowrap" suppressHydrationWarning>
      {prefix ? `${prefix} ` : ""}
      {timeAgo(at, now, timeZone)}
    </time>
  );
}

function NoteBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-ink-200 pt-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      {children}
    </div>
  );
}

function NoteForm({
  assignmentId,
  initial,
  onCancel,
  onSaved,
  onFailed,
}: {
  assignmentId: string;
  initial: string;
  onCancel: () => void;
  onSaved: () => void;
  onFailed: () => void;
}) {
  const fieldId = useId();
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await updateNoteAction(assignmentId, prev, formData);
    } catch {
      const note = formData.get("note");
      return { ok: false, message: OFFLINE_MESSAGE, values: { note: typeof note === "string" ? note : "" } };
    }
    if (result?.ok) onSaved();
    else if (!result?.fieldErrors?.note) onFailed();
    return result;
  }, initialActionState);
  const noteError = state?.fieldErrors?.note;

  return (
    <form action={formAction} className="mb-2 mt-1 space-y-2">
      <Label htmlFor={fieldId}>Note for your leader</Label>
      <Textarea
        id={fieldId}
        name="note"
        rows={3}
        maxLength={LIMITS.noteMax}
        defaultValue={state?.values?.note ?? initial}
        placeholder="What did you do? Add links or where to find it."
        invalid={!!noteError}
        aria-describedby={noteError ? `${fieldId}-error` : undefined}
        autoFocus
      />
      <FieldError id={`${fieldId}-error`}>{noteError}</FieldError>
      {!noteError && state && !state.ok && <FormMessage state={state} />}
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="Saving…">Save note</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
