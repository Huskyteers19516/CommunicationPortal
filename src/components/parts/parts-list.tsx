"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { DateOnly } from "@/lib/dates";
import type { PartItem, PartsView } from "@/server/queries/parts";
import { focusInView, PartCard } from "./part-card";

/** How long a confirmation ("You're making “X”.") stays on screen. */
const MESSAGE_MS = 6000;

/**
 * The parts on one tab of the Parts queue. Owns the status line (the latest thing the viewer did, read
 * out by screen readers and shown above the bottom tab bar) and, when a card leaves the list (marked
 * done, removed, put back in the queue), moves focus to the next card, or the previous one at the end.
 */
export function PartsList({
  parts,
  view,
  today,
  nowIso,
  timeZone,
  queueLength,
  empty,
}: {
  parts: PartItem[];
  view: PartsView;
  today: DateOnly;
  nowIso: string;
  timeZone: string;
  queueLength: number;
  /** Shown instead of the list when there are no parts (the status line stays, so the last change is still announced). */
  empty: ReactNode;
}) {
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  /** The card the latest action came from, until the list shows its result. */
  const pending = useRef<{ id: string; index: number; ok: boolean; message: string } | null>(null);

  // A newer action replaces the message; otherwise it clears itself so it can't go stale.
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (parts.some((x) => x.id === p.id)) return; // Still here: the card moves focus itself.
    // An error for a card that's gone (e.g. someone else finished it) shows here instead of on the card.
    if (!p.ok) setStatus({ text: p.message, ok: false });
    const names = listRef.current?.querySelectorAll<HTMLElement>("[data-part-focus]");
    const next = names && names.length > 0 ? names[Math.min(p.index, names.length - 1)] : null;
    if (next) focusInView(next);
    else statusRef.current?.focus();
  }, [parts]);

  return (
    <>
      {parts.length === 0 && empty}
      <ol ref={listRef} hidden={parts.length === 0} className="space-y-3" aria-label={view === "done" ? "Finished parts" : "Parts queue"}>
        {parts.map((part, index) => (
          <li key={part.id}>
            <PartCard
              part={part}
              view={view}
              today={today}
              nowIso={nowIso}
              timeZone={timeZone}
              queueLength={queueLength}
              onResult={(p, result) => {
                pending.current = { id: p.id, index, ...result };
                if (result.ok) setStatus({ text: result.message, ok: true });
              }}
            />
          </li>
        ))}
      </ol>
      {/* Always rendered so screen readers announce each change; focused as a last resort (list emptied). */}
      <div className="pointer-events-none fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 flex justify-center lg:inset-x-auto lg:bottom-6 lg:right-8">
        <p
          ref={statusRef}
          role="status"
          tabIndex={-1}
          className={cn(
            // Empty: no box, but still in the accessibility tree so the next message is announced.
            "max-w-md rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg wrap-anywhere empty:p-0 empty:shadow-none",
            status?.ok === false ? "bg-red-700 text-white" : "bg-ink-900 text-white",
          )}
        >
          {/* At most two lines on screen (screen readers still get all of it). Cards keep what has focus
              above this (FOCUS_SCROLL_MARGIN), and taps pass through it to the page. */}
          {status && <span className="line-clamp-2">{status.text}</span>}
        </p>
      </div>
    </>
  );
}
