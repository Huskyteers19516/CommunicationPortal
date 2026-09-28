"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/** How long a confirmation ("Entry saved.") stays on screen. */
const MESSAGE_MS = 5000;
/** Frames to wait for the refreshed page to show (or drop) an entry before giving up on moving focus. */
const FOCUS_TRIES = 120;

interface EntryRegionValue {
  /** Say what happened (a status line screen readers announce, shown for a few seconds). */
  announce: (message: string) => void;
  /**
   * Once the page shows this entry, move keyboard focus to it (and scroll it into view). When it isn't on this
   * screen (e.g. oldest first with more than one screen), focus goes to the "New entry" button instead.
   */
  focusEntry: (entryId: string) => void;
  /** Once this entry is gone from the page, move focus to the entry that took its place (or the "New entry" button). */
  focusAfterRemoving: (entryId: string) => void;
}

const EntryRegionContext = createContext<EntryRegionValue | null>(null);

export function useEntryRegion(): EntryRegionValue {
  const value = useContext(EntryRegionContext);
  if (!value) throw new Error("useEntryRegion must be used inside <EntryRegion>");
  return value;
}

function entryElement(id: string): HTMLElement | null {
  return document.getElementById(`entry-${id}`);
}

function focusInView(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
}

/**
 * Wraps a notebook page's composer and entries: owns the status line and moves focus after saves and deletes,
 * waiting for the refreshed page (the Server Action's result and the new page data don't always land together).
 */
export function EntryRegion({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const waitFor = useCallback((check: () => boolean, giveUp?: () => void) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    let tries = 0;
    const step = () => {
      frame.current = null;
      if (check()) return;
      if (++tries >= FOCUS_TRIES) {
        giveUp?.();
        return;
      }
      frame.current = requestAnimationFrame(step);
    };
    step();
  }, []);

  const value = useMemo<EntryRegionValue>(
    () => ({
      announce: (text) => setMessage(text),
      focusEntry: (id) =>
        waitFor(
          () => {
            const el = entryElement(id);
            if (el) focusInView(el);
            return !!el;
          },
          () => rootRef.current?.querySelector<HTMLElement>("[data-new-entry]")?.focus(),
        ),
      focusAfterRemoving: (id) => {
        const entries = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-entry]") ?? []);
        const index = entries.findIndex((el) => el.id === `entry-${id}`);
        waitFor(() => {
          if (entryElement(id)) return false;
          const now = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-entry]") ?? []);
          const next = now[index] ?? now[index - 1] ?? rootRef.current?.querySelector<HTMLElement>("[data-new-entry]");
          if (next) focusInView(next);
          return true;
        });
      },
    }),
    [waitFor],
  );

  return (
    <EntryRegionContext.Provider value={value}>
      <div ref={rootRef}>{children}</div>
      {/* Always rendered so screen readers announce each change. */}
      <p role="status" className="sr-only">
        {message}
      </p>
      {/* The same message on screen, above the bottom tab bar on phones. */}
      {message && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-4 bottom-20 z-40 mx-auto max-w-sm rounded-lg bg-ink-900 px-4 py-3 text-center text-sm font-medium text-white shadow-lg lg:bottom-6 lg:left-auto lg:right-6 lg:mx-0"
        >
          {message}
        </div>
      )}
    </EntryRegionContext.Provider>
  );
}
