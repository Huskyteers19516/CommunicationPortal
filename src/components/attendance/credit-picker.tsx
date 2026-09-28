"use client";

import { CircleCheck, LockKeyhole } from "lucide-react";
import { startTransition, useActionState, useId, useOptimistic } from "react";
import { setMyCreditAction } from "@/app/(app)/attendance/actions";
import type { AttendanceKind, CheckInMethod } from "@/generated/prisma/enums";
import { initialActionState } from "@/lib/action-state";
import { ATTENDANCE_KIND_LABELS, type CreditOptionId, memberCreditOptions } from "@/lib/attendance";
import { cn } from "@/lib/cn";

export interface MyCredit {
  /** The option it counts as now (null for a value no option has). */
  option: CreditOptionId | null;
  /** "1/2 EC" */
  label: string;
  /** In sixths (0 = an admin marked me as not here). */
  credit: number;
  method: CheckInMethod;
  /** An admin changed it: then only they can (it shows read-only). */
  changedByName: string | null;
  /** Added by hand and nobody changed it since (a scan while it's open makes it a real check-in). */
  untouchedByHand: boolean;
  /** The session is open today: people put on the list by hand can still scan in. */
  open: boolean;
}

/**
 * What my check-in counts as, right after checking in. At Regular it's 1 (nothing to pick: only admins make it
 * less). At Flex, "How long are you at Flex?": 1/2 Flex or 1 Flex as big radio buttons — 1 Flex is already saved
 * when I check in, picking the other saves right away (shown before the server answers), focus stays on the choice,
 * and a status line says it's saved; only that day. Once an admin changed it, it's shown read-only with who did.
 * Added by hand (I didn't scan), it says who added me and, while it's open, to scan the code if I'm here now.
 */
export function CreditPicker({
  sessionId,
  kind,
  credit,
  target,
}: {
  sessionId: string;
  kind: AttendanceKind;
  credit: MyCredit;
  /** The weekly target, for the hint. */
  target: number | null;
}) {
  const [state, formAction, saving] = useActionState(setMyCreditAction, initialActionState);
  const [shown, setShown] = useOptimistic(credit.option);
  const id = useId();
  const kindLabel = ATTENDANCE_KIND_LABELS[kind];
  const toward = target ? ` toward your ${target} a week` : "";

  const by = credit.changedByName ?? "An admin";
  if (credit.credit <= 0) {
    // Put down as No credit before they got here: scanning in now still counts.
    const canScan = credit.open && credit.method === "MANUAL" && credit.untouchedByHand;
    return (
      <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="min-w-0 wrap-anywhere">
          {kindLabel}: {by} marked you as not here (No credit).{" "}
          {canScan ? "If you're here now, scan the code to check in." : "Ask them if that's wrong."}
        </p>
      </div>
    );
  }
  if (credit.method === "MANUAL") {
    return (
      <div className="flex gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-700">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
        <p className="min-w-0 wrap-anywhere">
          {kindLabel}: {by} added you by hand as <span className="font-semibold text-ink-900">{credit.label}</span>.{" "}
          {credit.open ? "If you're here now, scan the code to check in." : "Ask them if it's wrong."}
        </p>
      </div>
    );
  }
  if (credit.changedByName) {
    return (
      <div className="flex gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-700">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden />
        <p className="min-w-0 wrap-anywhere">
          {kindLabel} counts as <span className="font-semibold text-ink-900">{credit.label}</span> ({credit.changedByName} set it). Ask
          them if it&apos;s wrong.
        </p>
      </div>
    );
  }
  const options = memberCreditOptions(kind);
  if (options.length === 0) {
    return (
      <p className="flex gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-700">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
        <span className="min-w-0">
          {kindLabel} counts as <span className="font-semibold text-ink-900">{credit.label}</span>
          {toward}.
        </span>
      </p>
    );
  }

  function pick(option: CreditOptionId) {
    const formData = new FormData();
    formData.set("sessionId", sessionId);
    formData.set("option", option);
    startTransition(() => {
      setShown(option);
      formAction(formData);
    });
  }

  const error = !saving && state && !state.ok ? state.message : "";
  const status = saving ? "Saving…" : error || (state?.ok ? (state.message ?? "") : "");

  return (
    <fieldset className="space-y-2" aria-describedby={`${id}-hint`}>
      <legend className="text-base font-semibold text-ink-900">How long are you at Flex?</legend>
      <p id={`${id}-hint`} className="text-xs text-ink-500">
        {target ? `It counts toward your ${target} a week. ` : ""}You can change it until the end of today.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => (
          <label
            key={o.id}
            className={cn(
              "flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
              "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/50",
              shown === o.id ? "border-brand-600 bg-brand-50" : "border-ink-200 bg-white hover:border-brand-300",
            )}
          >
            <input
              type="radio"
              name={`${id}-credit`}
              value={o.id}
              checked={shown === o.id}
              onChange={() => pick(o.id)}
              aria-label={o.label}
              aria-describedby={`${id}-${o.id.replace("/", "-")}`}
              className="size-5 shrink-0 accent-brand-600 focus:outline-none"
            />
            <span className="min-w-0">
              <span className="block font-semibold text-ink-900">{o.label}</span>
              <span id={`${id}-${o.id.replace("/", "-")}`} className="block text-xs text-ink-500">
                {o.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p role="status" className={cn("min-h-4 text-xs", error ? "text-red-600" : "text-ink-500")}>
        {status}
      </p>
    </fieldset>
  );
}
