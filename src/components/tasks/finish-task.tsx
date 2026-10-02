"use client";

import { CircleCheckBig, RotateCcw } from "lucide-react";
import { useActionState, useEffect, useId, useRef } from "react";
import { finishTaskAction, reopenTaskAction } from "@/app/(app)/manage/tasks/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { Button } from "../ui/button";
import { SubmitButton } from "../ui/submit-button";

/** Someone on the task whose item isn't approved yet, as the confirm dialog lists them. */
export interface FinishTaskPerson {
  id: string;
  name: string;
  /** "To do", "Checked off", "Sent back". */
  label: string;
  /** Checked off and waiting for a leader's review. */
  waiting: boolean;
  isMe: boolean;
}

/** How many people the dialog names before "and N more". */
const NAMES_SHOWN = 8;

const optionClass =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-ink-200 px-3 py-2.5 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/60 has-[:checked]:ring-1 has-[:checked]:ring-brand-500 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";

function ErrorLine({ state, className }: { state: ActionState; className?: string }) {
  if (!state || state.ok || !state.message) return null;
  return (
    <p role="alert" className={cn("text-sm text-red-600", className)}>
      {state.message}
    </p>
  );
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** The Reopen confirm: only promises to put people back when someone was counted as done by finishing. */
function reopenConfirm(counted: number): string {
  if (counted === 0) return "Reopen this task? People can check it off and sign up again.";
  const who = counted === 1 ? "The person who was counted as done" : `The ${counted} people who were counted as done`;
  return `Reopen this task? ${who} when it was finished ${counted === 1 ? "goes" : "go"} back to where they were, and people can check it off and sign up again.`;
}

/**
 * "Mark task finished" (with a confirm dialog that says who hasn't been approved and asks whether it counts as done
 * for them) or, once it's finished, "Reopen task". For people who manage the task, on its manage page and its
 * dashboard page. After either one, focus moves to the button that replaced it, and a screen-reader status line says
 * what happened (the page itself shows it: the Finished badge and banner, or the people's statuses going back).
 */
export function FinishTaskControls({
  taskId,
  title,
  finished,
  total,
  notApproved,
  canCountOwn,
  counted,
}: {
  taskId: string;
  title: string;
  finished: boolean;
  /** People on the task. */
  total: number;
  /** People on it whose item isn't approved yet. */
  notApproved: FinishTaskPerson[];
  /** The viewer's own item can be counted (all-scope staff); subteam leaders don't approve their own work. */
  canCountOwn: boolean;
  /** Items approved only because the task was counted as done for everyone (what "Reopen task" puts back). */
  counted: number;
}) {
  const [finishState, finishAction] = useActionState(finishTaskAction, initialActionState);
  const [reopenState, reopenAction] = useActionState(reopenTaskAction, initialActionState);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // The most recent success decides the status line (nonces grow over time).
  const finishNonce = finishState?.ok ? (finishState.nonce ?? 0) : 0;
  const reopenNonce = reopenState?.ok ? (reopenState.nonce ?? 0) : 0;
  const message =
    finishNonce > reopenNonce ? (finishState?.message ?? "") : reopenNonce > finishNonce ? (reopenState?.message ?? "") : "";

  // The page (and so which button shows) updates together with the action result.
  useEffect(() => {
    if (!finishNonce) return;
    if (dialogRef.current?.open) dialogRef.current.close();
    (reopenRef.current ?? statusRef.current)?.focus();
  }, [finishNonce]);
  useEffect(() => {
    if (!reopenNonce) return;
    (openerRef.current ?? statusRef.current)?.focus();
  }, [reopenNonce]);

  const me = notApproved.find((p) => p.isMe);
  const ownExcluded = !canCountOwn && !!me;
  /** A subteam leader's own item is waiting for review: finishing for everyone would strand it (the service refuses). */
  const ownWaiting = ownExcluded && !!me?.waiting;
  const others = notApproved.filter((p) => !(p.isMe && ownExcluded));
  const shown = others.slice(0, NAMES_SHOWN);
  const hidden = others.length - shown.length;
  const one = others.length === 1 ? firstName(others[0].name) : null;

  let summary: string;
  if (total === 0) summary = "Nobody is on this task.";
  else if (others.length === 0) summary = ownExcluded ? "Everyone else on it is already approved." : "Everyone on it is already approved.";
  else if (others.length === 1) summary = `${others[0].name} hasn't been approved yet.`;
  else if (others.length === total) summary = `None of the ${total} people on it have been approved yet:`;
  else summary = `${others.length} of the ${total} people on it haven't been approved yet:`;

  function close() {
    dialogRef.current?.close();
  }

  return (
    <div className="inline-flex max-w-full flex-col items-start">
      {finished ? (
        <form action={reopenAction} className="inline-flex max-w-full flex-col items-start">
          <input type="hidden" name="taskId" value={taskId} />
          <SubmitButton ref={reopenRef} variant="secondary" pendingText="Reopening…" confirm={reopenConfirm(counted)}>
            <RotateCcw className="size-4" aria-hidden />
            Reopen task
          </SubmitButton>
          <ErrorLine state={reopenState} className="mt-1 max-w-64 text-xs" />
        </form>
      ) : (
        <>
          <Button ref={openerRef} variant="secondary" aria-haspopup="dialog" onClick={() => dialogRef.current?.showModal()}>
            <CircleCheckBig className="size-4" aria-hidden />
            Mark task finished
          </Button>
          <dialog
            ref={dialogRef}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onClose={() => openerRef.current?.focus()}
            className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-ink-200 bg-white p-0 text-ink-900 shadow-xl backdrop:bg-ink-900/40"
          >
            <form action={finishAction} className="space-y-4 p-4 sm:p-5">
              <input type="hidden" name="taskId" value={taskId} />
              <div>
                <h2 id={titleId} className="text-lg font-semibold text-ink-900">
                  Mark this task finished?
                </h2>
                <p className="mt-0.5 text-sm text-ink-500 wrap-anywhere">{title}</p>
              </div>

              <div id={descriptionId} className="space-y-2 text-sm text-ink-700">
                <p>{summary}</p>
                {others.length > 1 && (
                  <ul className="space-y-1 rounded-lg border border-ink-100 bg-ink-50 px-3 py-2">
                    {shown.map((p) => (
                      <li key={p.id} className="flex min-w-0 items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate font-medium text-ink-900">{p.name}</span>
                        <span className="shrink-0 text-xs text-ink-500">{p.label}</span>
                      </li>
                    ))}
                    {hidden > 0 && <li className="text-xs text-ink-500">and {hidden} more</li>}
                  </ul>
                )}
              </div>

              {others.length > 0 ? (
                // Remounts (and so re-picks the default) if the viewer's own item starts or stops waiting.
                <fieldset key={ownWaiting ? "own-waiting" : "open"} className="space-y-2">
                  <legend className="mb-2 text-sm font-medium text-ink-800">
                    {one ? `What about ${one}?` : "What about them?"}
                  </legend>
                  <label className={optionClass}>
                    <input
                      type="radio"
                      name="credit"
                      value="everyone"
                      defaultChecked={!ownWaiting}
                      disabled={ownWaiting}
                      className="mt-0.5 size-4 shrink-0 accent-brand-600"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink-900">
                        {one ? `Count it as done for ${one}` : "Count it as done for everyone still on it"}
                      </span>
                      <span className="block text-xs text-ink-500">
                        {ownWaiting
                          ? "Not while your own item is waiting for review (see below)."
                          : one
                            ? `${one}'s item gets approved. Reopening the task puts it back.`
                            : "Their items get approved. Reopening the task puts them back."}
                      </span>
                    </span>
                  </label>
                  <label className={optionClass}>
                    <input
                      type="radio"
                      name="credit"
                      value="none"
                      defaultChecked={ownWaiting}
                      className="mt-0.5 size-4 shrink-0 accent-brand-600"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink-900">
                        {one ? `Just close it — ${one} gets no credit` : "Just close it — no credit"}
                      </span>
                      <span className="block text-xs text-ink-500">
                        {one
                          ? `It comes off ${one}'s list without counting.`
                          : "Their items come off their lists without counting. Only people already approved count."}
                      </span>
                    </span>
                  </label>
                </fieldset>
              ) : (
                <input type="hidden" name="credit" value="none" />
              )}

              {ownExcluded && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {ownWaiting
                    ? "Your own item is waiting for review, and leaders don't approve their own work. Ask another leader or the captain to approve it first — if you finish now, it's closed without credit."
                    : "Your own item isn't counted — leaders don't approve their own work — so it's closed without credit. If you did it, check it off and ask another leader or the captain to approve it before you finish."}
                </p>
              )}

              <p className="text-xs text-ink-500">
                Sign-ups close and nobody can check it off until the task is reopened. Nobody gets an email.
              </p>

              <ErrorLine state={finishState} />

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <SubmitButton pendingText="Finishing…">
                  <CircleCheckBig className="size-4" aria-hidden />
                  Mark finished
                </SubmitButton>
              </div>
            </form>
          </dialog>
        </>
      )}
      {/*
        Always rendered so screen readers announce it, but visually hidden: shown under the button it stretched the
        header's button row. Sighted people see the outcome on the page. Focused only as a last resort (tabIndex -1).
      */}
      <p ref={statusRef} role="status" tabIndex={-1} className="sr-only">
        {message}
      </p>
    </div>
  );
}
