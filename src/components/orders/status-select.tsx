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
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
} from "react";
import { setOrderStatusAction } from "@/app/(app)/orders/actions";
import type { PurchaseStatus } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { PURCHASE_STATUS_LABELS, PURCHASE_STATUSES } from "@/lib/constants";
import { OrderStatusBadge, PURCHASE_STATUS_STYLES } from "./status-badge";

/**
 * Wait this long after a change before saving. Arrow keys on a closed menu change it one status at a time
 * (Windows, ChromeOS), so passing through "Approved" on the way to "Ordered" doesn't save (and record a status
 * change) for every status on the way. Leaving the page before then saves right away.
 */
const SAVE_DELAY_MS = 600;

/** What the menu last showed as saved: sent with every change, so one made from an out-of-date page is refused. */
interface Base {
  status: PurchaseStatus;
  /** The item's updatedAt (ISO); null = not known since our own last change (then it isn't sent). */
  seen: string | null;
}

function statusFormData(id: string, status: PurchaseStatus, base: Base): FormData {
  const formData = new FormData();
  formData.set("itemId", id);
  formData.set("status", status);
  formData.set("from", base.status);
  if (base.seen) formData.set("seen", base.seen);
  return formData;
}

interface PendingChange {
  id: string;
  description: string;
  status: PurchaseStatus;
  /** The items shown when it was sent, in order (to pick where focus goes if this one leaves the list). */
  order: string[];
  done: boolean;
  ok: boolean;
  /** Why it didn't go through. */
  message: string;
}

interface ListFocus {
  willChange(change: { id: string; description: string; status: PurchaseStatus }): void;
  finished(id: string, ok: boolean, message?: string): void;
}

const ListFocusContext = createContext<ListFocus | null>(null);

/** An item's status control (menu or badge) where it's visible (the list renders a table and phone cards; one is hidden). */
function visibleControl(root: HTMLElement, id: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(`[data-order-status="${CSS.escape(id)}"]`)) {
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

/** The visible status menu for an item, if the viewer has one. */
function visibleSelect(root: HTMLElement, id: string): HTMLElement | null {
  return visibleControl(root, id)?.querySelector<HTMLElement>("select") ?? null;
}

function visibleIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-status-select]"))
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => el.dataset.statusSelect ?? "");
}

/**
 * Wraps a filtered order list. When a status change moves an item out of the current filter (e.g. Open →
 * Done) — or a refused one does, because someone else changed it meanwhile — its row disappears: this says
 * where it went (or why nothing changed) and moves focus to the next item's status menu, so keyboard and
 * screen-reader users don't land on <body>.
 */
export function OrderStatusFocus({ children, className }: { children: ReactNode; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const pending = useRef<PendingChange | null>(null);

  const value = useMemo<ListFocus>(
    () => ({
      willChange(change) {
        const root = rootRef.current;
        pending.current = { ...change, order: root ? visibleIds(root) : [], done: false, ok: false, message: "" };
        if (statusRef.current) statusRef.current.textContent = "";
      },
      finished(id, ok, message = "") {
        if (pending.current?.id === id) Object.assign(pending.current, { done: true, ok, message });
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
    // Still listed (as a menu, or a badge now): its own line says what happened, and it keeps focus.
    if (visibleControl(root, change.id)) return;
    if (statusRef.current) {
      statusRef.current.dataset.tone = change.ok ? "ok" : "error";
      statusRef.current.textContent = change.ok
        ? `“${change.description}” moved to ${PURCHASE_STATUS_LABELS[change.status]}.`
        : `“${change.description}” wasn't changed: ${change.message || "Something went wrong. Please try again."}`;
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
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="text-sm font-medium text-brand-800 wrap-anywhere focus:outline-none data-[tone=error]:text-red-700 [&:not(:empty)]:mb-3"
      />
      <div ref={rootRef} className={className}>
        {children}
      </div>
    </ListFocusContext.Provider>
  );
}

/**
 * An item's status: a colored menu that saves when it changes (like the dropdown in the old sheet), with a small
 * "Saving… / Saved. / error" line; the menu stays enabled while saving, so focus stays on it. People who can't
 * change it (`options` = the statuses the viewer may pick, including the current one) see a badge — with the
 * same line, so a change that's refused (the page then catches up) still says why; if the menu had focus, the
 * badge and its line get it. Every change says what the menu showed (`from`, `seen`): the server refuses one
 * made from an out-of-date page instead of undoing someone else's change.
 */
export function OrderStatusControl({
  id,
  description,
  status,
  updatedAt,
  options,
  className,
}: {
  id: string;
  /** The item's description, for the label and messages. */
  description: string;
  status: PurchaseStatus;
  /** The item's last change (ISO), as the page loaded it. */
  updatedAt: string;
  options: PurchaseStatus[];
  className?: string;
}) {
  const list = useContext(ListFocusContext);
  const base = useRef<Base>({ status, seen: updatedAt });
  // The page caught up (after a save, or someone else's change): that's what the menu shows now.
  useEffect(() => {
    base.current = { status, seen: updatedAt };
  }, [status, updatedAt]);
  const save = useCallback(
    async (prev: ActionState, formData: FormData) => {
      // Read when it's sent, not when it was picked: a change queued behind another starts from that one.
      formData.set("from", base.current.status);
      if (base.current.seen) formData.set("seen", base.current.seen);
      else formData.delete("seen");
      const result = await setOrderStatusAction(prev, formData);
      if (result?.ok) base.current = { status: formData.get("status") as PurchaseStatus, seen: null };
      list?.finished(id, !!result?.ok, result?.message);
      return result;
    },
    [id, list],
  );
  const [state, formAction, saving] = useActionState(save, initialActionState);
  const [shown, setShown] = useOptimistic(status);
  /** Picked but not sent yet (see SAVE_DELAY_MS). */
  const [draft, setDraft] = useState<PurchaseStatus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The same pick, for flushing it when the page goes away. */
  const pending = useRef<PurchaseStatus | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  /** The menu had focus when the last change was sent (so focus moves to the badge if the menu goes away). */
  const hadFocus = useRef(false);
  const badgeRef = useRef<HTMLDivElement>(null);

  const value = draft ?? shown;

  function send(next: PurchaseStatus) {
    pending.current = null;
    hadFocus.current = selectRef.current !== null && document.activeElement === selectRef.current;
    startTransition(() => {
      setDraft(null);
      if (next === status) return;
      setShown(next);
      list?.willChange({ id, description, status: next });
      formAction(statusFormData(id, next, base.current));
    });
  }

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.currentTarget.value as PurchaseStatus;
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
    else if (next !== status) void setOrderStatusAction(initialActionState, statusFormData(id, next, base.current));
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
  const message = busy ? "Saving…" : (error ?? (state?.ok ? state.message : ""));
  // The picked status is always listed, even while the page catches up with what it allows next.
  const choices = PURCHASE_STATUSES.filter((s) => s === value || options.includes(s));
  const asBadge = options.length <= 1 && !busy;
  const statusLine = (
    <p role="status" className={cn("text-xs wrap-anywhere [&:not(:empty)]:mt-1", error ? "text-red-600" : "text-ink-500")}>
      {message}
    </p>
  );

  // The menu that had focus turned into a badge (e.g. a refused change: someone else marked it N/A meanwhile):
  // keep focus here, on the badge and the line saying why, instead of dropping it to <body>.
  useLayoutEffect(() => {
    if (!asBadge || !hadFocus.current) return;
    hadFocus.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    badgeRef.current?.focus();
  }, [asBadge]);

  // Nothing the viewer can change it to (or no longer, after the page caught up with someone else's change): a
  // badge, still with the line saying why their change didn't go through.
  if (asBadge) {
    return (
      <div
        ref={badgeRef}
        data-order-status={id}
        tabIndex={-1}
        className={cn("min-w-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40", className)}
      >
        <span className="flex min-h-10 items-center">
          <OrderStatusBadge status={status} />
        </span>
        {statusLine}
      </div>
    );
  }

  return (
    <div data-order-status={id} className={cn("min-w-0", className)}>
      <div className="relative">
        <select
          ref={selectRef}
          value={value}
          onChange={onChange}
          data-status-select={id}
          aria-label={`Status for ${description}`}
          aria-invalid={error ? true : undefined}
          className={cn(
            // pl-2.5 + pr-7 (+ borders) leave the table's 116px menu ~76px for text: "Requested" is ~68px (Inter 14px medium).
            "block h-10 w-full min-w-0 cursor-pointer appearance-none rounded-lg border pl-2.5 pr-7 text-sm font-medium shadow-sm transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/40",
            PURCHASE_STATUS_STYLES[value].control,
            error && "border-red-400",
          )}
        >
          {choices.map((s) => (
            <option key={s} value={s}>
              {PURCHASE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 opacity-60" aria-hidden />
      </div>
      {statusLine}
    </div>
  );
}
