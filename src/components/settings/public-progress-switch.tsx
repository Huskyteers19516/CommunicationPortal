"use client";

import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useOptimistic, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";

type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

/**
 * Settings → Team website: "Show me on the team website's progress page". Saves as soon as it's flipped (like the
 * email switches): it shows the change while saving, then whatever is really saved (`show`, from the page).
 */
export function PublicProgressSwitch({ action, show }: { action: FormAction; show: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, showSaving] = useOptimistic(show);
  const [result, setResult] = useState<ActionState>(null);
  const id = "public-progress-show";

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const formData = new FormData(e.currentTarget);
    const next = formData.get("show") === "on";
    startTransition(async () => {
      showSaving(next);
      let saved: ActionState;
      let reachedServer = true;
      try {
        saved = await action(result, formData);
      } catch {
        saved = { ok: false, message: OFFLINE_MESSAGE };
        reachedServer = false;
      }
      startTransition(() => {
        setResult(saved);
        if (!saved?.ok && reachedServer) router.refresh();
      });
    });
  }

  return (
    <form onSubmit={onSubmit} aria-busy={pending}>
      <label htmlFor={id} className={cn("flex min-h-11 items-center justify-between gap-4", pending ? "cursor-progress" : "cursor-pointer")}>
        <span className="min-w-0">
          <span id={`${id}-label`} className="block text-sm font-medium text-ink-900">
            Show me on the team website&apos;s progress page
          </span>
          <span id={`${id}-desc`} className="mt-0.5 block text-sm text-ink-500">
            Your name, position, and how many checklist items you&apos;ve finished. Off: you&apos;re left off the list and
            out of recent completions. So nobody can work out your numbers from the totals, your items count in your
            subteam&apos;s and the team&apos;s totals only while someone else in your subteam is off too.
          </span>
        </span>
        <span className="relative inline-flex shrink-0 items-center">
          <input
            id={id}
            name="show"
            type="checkbox"
            role="switch"
            checked={shown}
            onChange={(e) => {
              if (!pending) e.currentTarget.form?.requestSubmit();
            }}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-desc`}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="h-7 w-12 rounded-full bg-ink-300 transition-colors peer-checked:bg-brand-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute left-1 top-1 size-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
          />
        </span>
      </label>
      {/* Always rendered (empty when idle) so screen readers announce changes. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="text-xs">
        {pending && (
          <span className="mt-1.5 flex items-center gap-1.5 text-ink-500">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
            Saving…
          </span>
        )}
        {!pending && result?.ok && (
          <span className="mt-1.5 flex items-center gap-1.5 font-medium text-brand-700">
            <CircleCheck className="size-3.5 shrink-0" aria-hidden />
            {result.message ?? "Saved"}
          </span>
        )}
        {!pending && result && !result.ok && (
          <span className="mt-1.5 flex items-start gap-1.5 font-medium text-red-700">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>Not saved. {result.message ?? "Please try again."}</span>
          </span>
        )}
      </p>
    </form>
  );
}
