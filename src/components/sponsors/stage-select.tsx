"use client";

import { ChevronDown } from "lucide-react";
import {
  createContext,
  type ChangeEvent,
  type ReactNode,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useOptimistic,
  useRef,
  useState,
} from "react";
import { setSponsorshipStageAction } from "@/app/(app)/sponsors/actions";
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { SPONSORSHIP_STAGE_LABELS, SPONSORSHIP_STAGES } from "@/lib/constants";
import { STAGE_STYLES } from "./stage-badge";

/**
 * Wait this long after a change before saving. Arrow keys on a closed menu change it one stage at a
 * time (Windows, ChromeOS), so passing through "Submitted" on the way to "Accepted" doesn't save
 * (and fill in a date) for every stage on the way. Leaving the page before then saves right away.
 */
const SAVE_DELAY_MS = 600;

function stageFormData(id: string, stage: SponsorshipStage): FormData {
  const formData = new FormData();
  formData.set("sponsorshipId", id);
  formData.set("stage", stage);
  return formData;
}

interface PendingChange {
  id: string;
  name: string;
  stage: SponsorshipStage;
  /** The sponsors shown when it was sent, in order (to pick where focus goes if this one leaves the list). */
  order: string[];
  done: boolean;
  ok: boolean;
}

interface ListFocus {
  willChange(change: { id: string; name: string; stage: SponsorshipStage }): void;
  finished(id: string, ok: boolean): void;
}

const ListFocusContext = createContext<ListFocus | null>(null);

/** The visible stage menu for a sponsor (the list renders a table and phone cards; one is hidden). */
function visibleSelect(root: HTMLElement, id: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(`[data-stage-select="${CSS.escape(id)}"]`)) {
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

function visibleIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-stage-select]"))
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => el.dataset.stageSelect ?? "");
}

/**
 * Wraps a filtered sponsor list. When a stage change moves a sponsor out of the current filter (e.g. "To do"
 * → Submitted), its row disappears: this says where it went and moves focus to the next sponsor's stage
 * menu, so keyboard and screen-reader users don't land on <body>.
 */
export function StageChangeFocus({ children, className }: { children: ReactNode; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const pending = useRef<PendingChange | null>(null);

  const value = useMemo<ListFocus>(
    () => ({
      willChange(change) {
        const root = rootRef.current;
        pending.current = { ...change, order: root ? visibleIds(root) : [], done: false, ok: false };
        if (statusRef.current) statusRef.current.textContent = "";
      },
      finished(id, ok) {
        if (pending.current?.id === id) Object.assign(pending.current, { done: true, ok });
      },
    }),
    [],
  );

  // New server data arrives together with the action's result.
  useEffect(() => {
    const change = pending.current;
    const root = rootRef.current;
    if (!change?.done || !root) return;
    pending.current = null;
    if (!change.ok || visibleSelect(root, change.id)) return;
    if (statusRef.current) {
      statusRef.current.textContent = `${change.name} moved to ${SPONSORSHIP_STAGE_LABELS[change.stage]}.`;
    }
    if (document.activeElement && document.activeElement !== document.body) return;
    const at = change.order.indexOf(change.id);
    const next = [...change.order.slice(at + 1), ...change.order.slice(0, Math.max(at, 0)).reverse()];
    for (const id of next) {
      const el = visibleSelect(root, id);
      if (el) {
        el.focus();
        return;
      }
    }
    statusRef.current?.focus();
  }, [children]);

  return (
    <ListFocusContext.Provider value={value}>
      {/* Filled in by the effect above (never by React), so screen readers announce it. */}
      <p ref={statusRef} role="status" tabIndex={-1} className="text-sm font-medium text-brand-800 focus:outline-none [&:not(:empty)]:mb-3" />
      <div ref={rootRef} className={className}>
        {children}
      </div>
    </ListFocusContext.Provider>
  );
}

/**
 * The stage as a colored menu that saves when it changes (like the dropdown in the Business team's sheet),
 * with a small "Saving… / Saved / error" line. The menu stays enabled while saving, so focus stays on it.
 */
export function StageSelect({
  id,
  name,
  stage,
  className,
}: {
  id: string;
  /** The sponsor's name, for the label and messages. */
  name: string;
  stage: SponsorshipStage;
  className?: string;
}) {
  const list = useContext(ListFocusContext);
  const save = useCallback(
    async (prev: ActionState, formData: FormData) => {
      const result = await setSponsorshipStageAction(prev, formData);
      list?.finished(id, !!result?.ok);
      return result;
    },
    [id, list],
  );
  const [state, formAction, saving] = useActionState(save, initialActionState);
  const [shown, setShown] = useOptimistic(stage);
  /** Picked but not sent yet (see SAVE_DELAY_MS). */
  const [draft, setDraft] = useState<SponsorshipStage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The same pick, for flushing it when the page goes away. */
  const pending = useRef<SponsorshipStage | null>(null);

  const value = draft ?? shown;

  function send(next: SponsorshipStage) {
    pending.current = null;
    startTransition(() => {
      setDraft(null);
      if (next === stage) return;
      setShown(next);
      list?.willChange({ id, name, stage: next });
      formAction(stageFormData(id, next));
    });
  }

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.currentTarget.value as SponsorshipStage;
    setDraft(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => send(next), SAVE_DELAY_MS);
  }

  /** Save a pick that's still waiting for SAVE_DELAY_MS now, instead of losing it. */
  const flush = useEffectEvent((unmounting: boolean) => {
    clearTimeout(timer.current);
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    if (!unmounting) send(next);
    // Unmounting (e.g. someone tapped a link right after picking): there's no menu left to show the
    // result, so call the action directly.
    else if (next !== stage) void setSponsorshipStageAction(initialActionState, stageFormData(id, next));
  });
  useEffect(() => {
    const onPageHide = () => flush(false);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush(false);
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush(true);
    };
  }, []);

  const busy = draft !== null || saving;
  const error = !busy && state && !state.ok ? state.message : undefined;
  const status = busy ? "Saving…" : (error ?? (state?.ok ? state.message : ""));

  return (
    <div className={cn("min-w-0", className)}>
      <div className="relative">
        <select
          value={value}
          onChange={onChange}
          data-stage-select={id}
          aria-label={`Stage for ${name}`}
          aria-invalid={error ? true : undefined}
          className={cn(
            // pl-2.5 + pr-7 (+ borders) leave 108px for text in the table's 148px menu: "Haven't started" is ~103px (Inter 14px medium).
            "block h-10 w-full min-w-0 cursor-pointer appearance-none rounded-lg border pl-2.5 pr-7 text-sm font-medium shadow-sm transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/40",
            STAGE_STYLES[value].control,
            error && "border-red-400",
          )}
        >
          {SPONSORSHIP_STAGES.map((s) => (
            <option key={s} value={s}>
              {SPONSORSHIP_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 opacity-60" aria-hidden />
      </div>
      <p role="status" className={cn("text-xs [&:not(:empty)]:mt-1", error ? "text-red-600" : "text-ink-500")}>
        {status}
      </p>
    </div>
  );
}
