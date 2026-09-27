"use client";

import { ListChecks, Trash2 } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useActionState,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import { deleteSponsorshipsAction } from "@/app/(app)/sponsors/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { bulkRemoveQuestion, SPONSORSHIP_BULK_REMOVE_MAX, selectUpTo } from "@/lib/sponsorships";

/** What selecting needs to know about each sponsor shown. */
export interface BulkRemoveItem {
  id: string;
  name: string;
  canDelete: boolean;
  fileCount: number;
}

const LOCKED_NOTE = "You can only remove sponsors you added. The Business leader can remove any.";
const MAX_NOTE = `Up to ${SPONSORSHIP_BULK_REMOVE_MAX} at a time.`;

/** Focus without the browser's own jump, then scroll just enough to show it (with its scroll margin). */
function focusInView(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

interface Selection {
  canBulkRemove: boolean;
  selecting: boolean;
  isSelected(id: string): boolean;
  set(ids: string[], on: boolean): void;
  /** "Select all": the removable sponsors shown, up to SPONSORSHIP_BULK_REMOVE_MAX. */
  selectAll(): void;
  start(): void;
  stop(): void;
  /** Keyboard shortcut from the top of the list to the bar's Remove (or Cancel, while Remove is off). */
  focusBar(): void;
  /** The sponsors shown that the viewer can remove, and which of them are ticked (in the list's order). */
  removable: BulkRemoveItem[];
  selected: BulkRemoveItem[];
  /** How many shown sponsors can't be ticked (someone else added them). */
  locked: number;
  lockedNoteId: string;
  maxNoteId: string;
  /** Ref callbacks: where focus goes when selection mode ends / starts. */
  registerToggle(el: HTMLButtonElement | null): void;
  registerSelectAll(el: HTMLInputElement | null): void;
}

const SelectionContext = createContext<Selection | null>(null);

/** The list's selection, or null outside <SponsorBulkRemove> (the list then has no checkboxes). */
export function useSponsorSelection(): Selection | null {
  return useContext(SelectionContext);
}

/**
 * "Select" mode for the sponsor list: checkboxes, "Select all" for the sponsors shown, and a sticky
 * "N selected · Cancel · Remove N" bar above the phone tab bar. After removing, selection mode ends and a
 * status line says what happened (and takes focus). Key it by the filter: a new filter starts over.
 * While the bar is up, `data-sticky-action-bar` gives the page scroll padding (globals.css), so what has
 * focus is kept above the bar and the phone tab bar.
 */
export function SponsorBulkRemove({
  items,
  canBulkRemove,
  children,
}: {
  items: BulkRemoveItem[];
  canBulkRemove: boolean;
  children: ReactNode;
}) {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [state, formAction] = useActionState(deleteSponsorshipsAction, initialActionState);
  const [seenNonce, setSeenNonce] = useState(state?.nonce);
  /** A result stays up until the next time someone starts selecting. */
  const [hiddenNonce, setHiddenNonce] = useState<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"selectAll" | "toggle" | null>(null);
  const lockedNoteId = useId();
  const maxNoteId = useId();

  const removable = items.filter((i) => i.canDelete);
  // Sponsors that left the list (removed, or moved out of the filter) drop out of the selection.
  const selected = removable.filter((i) => picked.has(i.id));

  // Something was removed: leave selection mode (adjusting state during render, no effect needed).
  if (state?.nonce !== seenNonce) {
    setSeenNonce(state?.nonce);
    if (state?.ok) {
      setSelecting(false);
      setPicked(new Set());
    }
  }
  // Nothing left to select (e.g. someone else removed them meanwhile).
  if (selecting && removable.length === 0) setSelecting(false);

  // Put focus on what happened, so keyboard and screen-reader users hear it instead of landing on <body>.
  useEffect(() => {
    if (state && statusRef.current) focusInView(statusRef.current);
  }, [state]);
  useEffect(() => {
    const target = focusNext.current === "selectAll" ? selectAllRef.current : focusNext.current === "toggle" ? toggleRef.current : null;
    focusNext.current = null;
    // Scrolled into view with the bar's scroll padding: on a phone, "Select" near the bottom of the screen would
    // otherwise leave "Select all" under the bar and the tab bar.
    if (target) focusInView(target);
  }, [selecting]);

  function start() {
    focusNext.current = "selectAll";
    setHiddenNonce(state?.nonce);
    setPicked(new Set());
    setSelecting(true);
  }
  function stop() {
    focusNext.current = "toggle";
    setPicked(new Set());
    setSelecting(false);
  }

  // Escape leaves selection mode: from the list, its toolbar, or the bar (or with focus nowhere in particular),
  // but not from other parts of the page, like the info card's editor or the phone menu.
  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const target = e.target instanceof Node ? e.target : null;
    if (target && target !== document.body && !rootRef.current?.contains(target)) return;
    stop();
  });
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (e: KeyboardEvent) => onEscape(e);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selecting]);

  const count = selected.length;
  const overMax = count > SPONSORSHIP_BULK_REMOVE_MAX;
  const canRemove = count > 0 && !overMax;

  const value: Selection = {
    canBulkRemove,
    selecting,
    isSelected: (id) => picked.has(id),
    set: (ids, on) =>
      setPicked((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      }),
    selectAll: () => setPicked((prev) => selectUpTo(removable.map((i) => i.id), prev)),
    start,
    stop,
    focusBar: () => {
      // The bar is stuck to the bottom of the screen already: no scrolling.
      (canRemove ? removeRef.current : cancelRef.current)?.focus({ preventScroll: true });
    },
    removable,
    selected,
    locked: items.length - removable.length,
    lockedNoteId,
    maxNoteId,
    registerToggle: (el) => {
      toggleRef.current = el;
    },
    registerSelectAll: (el) => {
      selectAllRef.current = el;
    },
  };

  const result = state && state.nonce !== hiddenNonce ? state : null;

  return (
    <SelectionContext.Provider value={value}>
      <div ref={rootRef}>
        {/* Always on the page (filled in after "Remove"), so screen readers announce it. scroll-mt: clear of the
            phone's sticky header when it takes focus. */}
        <div
          ref={statusRef}
          role="status"
          tabIndex={-1}
          className="scroll-mt-20 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 [&:not(:empty)]:mb-6"
        >
          {result?.message && (
            <Alert tone={result.ok ? "success" : "error"} role={null}>
              <span className="wrap-anywhere">{result.message}</span>
            </Alert>
          )}
        </div>
        {children}
        {selecting && (
          // Sticky above the phone tab bar (~64px + the iPhone home bar), like the review queue's bulk approve.
          <div data-sticky-action-bar="" className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-20 mt-4 lg:bottom-6">
            <form
              action={formAction}
              aria-label="Remove selected sponsors"
              className="flex items-center gap-2 rounded-xl border border-ink-200 bg-white/95 p-2 pl-4 shadow-lg backdrop-blur"
            >
              {selected.map((i) => (
                <input key={i.id} type="hidden" name="sponsorshipIds" value={i.id} />
              ))}
              <p className="mr-auto min-w-0 text-sm font-medium tabular-nums text-ink-800">
                {count} selected
                {/* Only after ticking more than 200 one by one ("Select all" stops at 200): the server would refuse. */}
                {overMax && <span className="block text-xs font-normal text-red-700">{MAX_NOTE}</span>}
              </p>
              <Button ref={cancelRef} variant="ghost" className="px-3" onClick={stop}>
                Cancel
              </Button>
              <SubmitButton
                ref={removeRef}
                variant="danger"
                disabled={!canRemove}
                pendingText="Removing…"
                confirm={bulkRemoveQuestion(
                  selected.map((i) => i.name),
                  selected.reduce((sum, i) => sum + i.fileCount, 0),
                )}
              >
                <Trash2 className="size-4" aria-hidden />
                {count === 0 ? (
                  "Remove"
                ) : (
                  <span>
                    Remove {count}
                    {/* The whole label from sm up; phones show "Remove 12" so the bar fits on one line at 375px. */}
                    <span className="sr-only sm:not-sr-only"> {count === 1 ? "sponsor" : "sponsors"}</span>
                  </span>
                )}
              </SubmitButton>
            </form>
          </div>
        )}
      </div>
    </SelectionContext.Provider>
  );
}

/** "Select" in the list's toolbar: starts (or ends) selection mode. Only for people who can remove something shown. */
export function BulkSelectToggle({ className }: { className?: string }) {
  const sel = useSponsorSelection();
  if (!sel?.canBulkRemove) return null;
  const { selecting, start, stop, registerToggle } = sel;
  return (
    <Button
      ref={registerToggle}
      variant={selecting ? "primary" : "secondary"}
      aria-pressed={selecting}
      onClick={() => (selecting ? stop() : start())}
      // Clear of the phone's sticky header and tab bar when focus comes back here.
      className={cn("scroll-mt-20 scroll-mb-24", className)}
    >
      <ListChecks className="size-4" aria-hidden />
      Select
    </Button>
  );
}

/**
 * The top of the list in selection mode: "Select all" for the sponsors shown (up to 200), why some can't be
 * ticked, and a keyboard shortcut to the Remove bar (which comes after the whole list).
 */
export function SelectAllRow() {
  const sel = useSponsorSelection();
  if (!sel?.selecting) return null;
  const { removable, selected, locked } = sel;
  const most = Math.min(removable.length, SPONSORSHIP_BULK_REMOVE_MAX);
  const all = most > 0 && selected.length >= most;
  const some = selected.length > 0 && !all;
  const capped = removable.length > SPONSORSHIP_BULK_REMOVE_MAX;
  return (
    <div className="flex flex-wrap items-center gap-x-3 border-b border-ink-100 bg-ink-50/60 px-2 py-1">
      <label className="flex min-h-10 cursor-pointer items-center gap-1 pr-2 text-sm font-medium text-ink-800">
        <span className="flex size-10 shrink-0 items-center justify-center">
          <input
            ref={(el) => {
              sel.registerSelectAll(el);
              // "Some ticked" shows as a dash (it can only be set from script).
              if (el) el.indeterminate = some;
            }}
            type="checkbox"
            checked={all}
            onChange={(e) => (e.currentTarget.checked ? sel.selectAll() : sel.set(removable.map((i) => i.id), false))}
            aria-describedby={capped ? sel.maxNoteId : undefined}
            className="size-5 rounded border-ink-300"
          />
        </span>
        <span>
          Select all{" "}
          <span className="font-normal text-ink-500">
            ({removable.length}
            {locked > 0 && " you can remove"})
          </span>
        </span>
      </label>
      {/* Hidden until it has keyboard focus: Tab from "Select all" jumps to the bar instead of through every row. */}
      <button
        type="button"
        onClick={sel.focusBar}
        className="sr-only rounded-md text-sm font-medium text-brand-700 underline underline-offset-2 focus:not-sr-only focus:inline-flex focus:min-h-10 focus:items-center focus:px-2"
      >
        Skip to Remove
      </button>
      {capped && (
        <p id={sel.maxNoteId} className="px-2 pb-2 text-xs text-ink-500 sm:px-0 sm:pb-0">
          {MAX_NOTE}
        </p>
      )}
      {locked > 0 && (
        <p id={sel.lockedNoteId} className="px-2 pb-2 text-xs text-ink-500 sm:px-0 sm:pb-0">
          {LOCKED_NOTE}
        </p>
      )}
    </div>
  );
}

/** A sponsor's checkbox (40px tap area). Sponsors the viewer can't remove get a disabled one that says why. */
export function SelectBox({ id, name, canDelete, className }: { id: string; name: string; canDelete: boolean; className?: string }) {
  const sel = useSponsorSelection();
  if (!sel?.selecting) return null;
  return (
    <label
      title={canDelete ? undefined : LOCKED_NOTE}
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg",
        canDelete ? "cursor-pointer hover:bg-ink-100" : "cursor-not-allowed",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={canDelete && sel.isSelected(id)}
        disabled={!canDelete}
        onChange={(e) => sel.set([id], e.currentTarget.checked)}
        aria-label={`Select ${name}`}
        aria-describedby={canDelete ? undefined : sel.lockedNoteId}
        data-select-sponsor={id}
        className="size-5 rounded border-ink-300 disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}
