"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  CircleCheck,
  ExternalLink,
  Hand,
  Pencil,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, type RefObject, useActionState, useEffect, useId, useRef, useState } from "react";
import {
  claimPartAction,
  finishPartAction,
  movePartAction,
  removePartAction,
  reopenPartAction,
  unclaimPartAction,
} from "@/app/(app)/parts/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { type DateOnly, timeAgo } from "@/lib/dates";
import type { PartItem, PartsView } from "@/server/queries/parts";
import { Avatar } from "../ui/avatar";
import { Button, buttonClasses, type ButtonSize, type ButtonVariant } from "../ui/button";
import { RichText } from "../ui/rich-text";
import { SubmitButton } from "../ui/submit-button";
import { ForBadge, MaterialBadge, NeededByBadge, ProcessBadge } from "./part-badges";

export type PartOp = "claim" | "drop" | "done" | "up" | "down" | "top" | "remove" | "reopen";

const SERVER_ACTIONS: Record<PartOp, (prev: ActionState, formData: FormData) => Promise<ActionState>> = {
  claim: claimPartAction,
  drop: unclaimPartAction,
  done: finishPartAction,
  up: movePartAction,
  down: movePartAction,
  top: movePartAction,
  remove: removePartAction,
  reopen: reopenPartAction,
};

const OPS = Object.keys(SERVER_ACTIONS) as PartOp[];
const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";
/** Notes longer than this start collapsed. */
const LONG_NOTES = 180;
/** Names longer than this are shortened in status messages, so the message stays a line or two. */
const MESSAGE_NAME_MAX = 40;

/**
 * Where focus lands after an action: kept clear of the sticky header above and, below, of the bottom tab
 * bar plus a two-line status message (phones), or the status message in the corner (desktop).
 */
export const FOCUS_SCROLL_MARGIN = "scroll-mt-24 scroll-mb-40 lg:scroll-mb-28";

/** Focus an element and scroll just enough that it (with its scroll margin) is in view. */
export function focusInView(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function shortName(name: string): string {
  const chars = Array.from(name);
  return chars.length <= MESSAGE_NAME_MAX ? name : `${chars.slice(0, MESSAGE_NAME_MAX - 1).join("").trimEnd()}…`;
}

function successMessage(op: PartOp, part: PartItem): string {
  const name = `“${shortName(part.name)}”`;
  switch (op) {
    case "claim":
      return `You're making ${name}. Mark it done when it's finished.`;
    case "drop":
      return `${part.isMaker ? "You dropped" : "Dropped"} ${name}. It's up for grabs again.`;
    case "done":
      return part.isMaker ? `${name} is done. Nice work!` : `Marked ${name} done.`;
    case "up":
      return `Moved ${name} up.`;
    case "down":
      return `Moved ${name} down.`;
    case "top":
      return `Moved ${name} to the top.`;
    case "remove":
      return `Removed ${name}.`;
    case "reopen":
      return `Put ${name} back in the queue.`;
  }
}

/** Only a button that exists and can take focus. */
function focusable(el: HTMLElement | null): HTMLElement | null {
  return el && el.isConnected && !el.hasAttribute("disabled") ? el : null;
}

/**
 * One part on the Parts queue: its rank, what it is, who's making it, and the buttons the viewer may
 * use. Every button posts to one action (by `op`); `onResult` tells the list what happened so it can
 * announce it and, when the card leaves the list (done, removed, put back), move focus on.
 *
 * While the card stays, focus follows sensibly for keyboard users: "I'll make it" → "Mark done",
 * "Drop it" → "I'll make it", moves stay on the same arrow (or the other one at an edge), and anything
 * else falls back to the part's name.
 */
export function PartCard({
  part,
  view,
  today,
  nowIso,
  timeZone,
  queueLength,
  photoIds,
  onResult,
}: {
  part: PartItem;
  view: PartsView;
  today: DateOnly;
  /** Request time and team timezone (server and browser render the same "2 h ago"). */
  nowIso: string;
  timeZone: string;
  /** Parts in the whole queue (the last rank). */
  queueLength: number;
  /** Makers' portal photos (user id → photo id), else initials. */
  photoIds?: Record<string, string>;
  onResult: (part: PartItem, result: { ok: boolean; message: string }) => void;
}) {
  const headingId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLElement>(null);
  const claimRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLButtonElement>(null);
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const topRef = useRef<HTMLButtonElement>(null);
  const lastOp = useRef<PartOp | null>(null);
  const handled = useRef<ActionState>(null);
  const isFirst = part.rank === 1;
  const isLast = part.rank === queueLength;

  const [state, dispatch] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const raw = formData.get("op");
    const op = OPS.find((o) => o === raw);
    if (!op) return prev;
    lastOp.current = op;
    let result: ActionState;
    try {
      result = await SERVER_ACTIONS[op](prev, formData);
    } catch {
      result = { ok: false, message: OFFLINE_MESSAGE, nonce: Date.now() };
    }
    const ok = !!result?.ok;
    onResult(part, { ok, message: ok ? successMessage(op, part) : (result?.message ?? OFFLINE_MESSAGE) });
    return result;
  }, initialActionState);

  // Runs once the page data (in its new state) and the result arrive together.
  useEffect(() => {
    if (!state || handled.current === state) return;
    handled.current = state;
    let target: HTMLElement | null = null;
    if (state.ok) {
      switch (lastOp.current) {
        case "claim":
          target = focusable(doneRef.current) ?? focusable(dropRef.current);
          break;
        case "drop":
          target = focusable(claimRef.current);
          break;
        case "up":
          target = focusable(isFirst ? downRef.current : upRef.current);
          break;
        case "down":
          target = focusable(isLast ? upRef.current : downRef.current);
          break;
        case "top":
          target = focusable(downRef.current);
          break;
      }
    } else {
      // A failed action leaves focus where it was, unless that button is gone (e.g. someone else grabbed it).
      const active = document.activeElement;
      if (active && active !== document.body && cardRef.current?.contains(active)) return;
    }
    const el = target ?? nameRef.current;
    if (el) focusInView(el);
  }, [state, isFirst, isLast]);

  const error = state && !state.ok ? state.message : undefined;
  const done = view === "done";
  const showTools = part.canMove || part.canEdit || part.canReopen;

  return (
    <article
      ref={cardRef}
      id={`part-${part.id}`}
      aria-labelledby={headingId}
      className={cn(
        "min-w-0 scroll-mt-24 rounded-xl border bg-white p-3 shadow-sm sm:p-4",
        part.isMaker ? "border-brand-300" : "border-ink-200",
      )}
    >
      <div className="flex items-start gap-3">
        <RankMark rank={part.rank} done={done} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 id={headingId} className="min-w-0 text-base font-semibold leading-snug text-ink-900">
              {part.canEdit ? (
                // Padded out to a ≥ 40px tap target (22px line + 2 × 10px) without moving the text.
                <Link
                  ref={nameRef as RefObject<HTMLAnchorElement>}
                  href={`/parts/${part.id}/edit`}
                  data-part-focus=""
                  className={cn(
                    "-my-2.5 block rounded py-2.5 underline-offset-2 wrap-anywhere hover:text-brand-800 hover:underline",
                    FOCUS_SCROLL_MARGIN,
                  )}
                >
                  {part.name}
                </Link>
              ) : (
                <span ref={nameRef} tabIndex={-1} data-part-focus="" className={cn("block rounded wrap-anywhere", FOCUS_SCROLL_MARGIN)}>
                  {part.name}
                </span>
              )}
            </h2>
            {part.quantity > 1 && (
              <p className="shrink-0 font-display text-lg font-semibold leading-snug tabular-nums text-ink-700">
                <span aria-hidden>×{part.quantity}</span>
                <span className="sr-only">Quantity: {part.quantity}</span>
              </p>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ProcessBadge process={part.process} />
            <MaterialBadge material={part.material} />
            <ForBadge category={part.category} label={part.forLabel} />
            {!done && <NeededByBadge neededBy={part.neededBy} today={today} />}
          </div>

          {part.requestedBy && (
            <p className="mt-1.5 text-xs text-ink-500 wrap-anywhere">
              Asked by {part.isRequester ? "you" : part.requestedBy.name}
            </p>
          )}
          {part.notes && <PartNotes notes={part.notes} />}
          {part.fileUrl && (
            <a
              href={part.fileUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={buttonClasses("secondary", "md", "mt-2.5")}
            >
              <ExternalLink className="size-4 shrink-0" aria-hidden />
              Open file
              <span className="sr-only"> for {part.name} (opens in a new tab)</span>
            </a>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-ink-100 pt-3">
        <StatusLine part={part} done={done} nowIso={nowIso} timeZone={timeZone} photoId={part.claimedBy ? photoIds?.[part.claimedBy.id] : undefined} />
        {(part.canClaim || part.canFinish || part.canUnclaim) && !done && (
          <div className="flex flex-wrap gap-2">
            {part.canClaim && (
              <OpButton op="claim" part={part} dispatch={dispatch} buttonRef={claimRef} variant="primary" pendingText="Grabbing…" label="I'll make it">
                <Hand className="size-4 shrink-0" aria-hidden />
              </OpButton>
            )}
            {part.canFinish && (
              <OpButton
                op="done"
                part={part}
                dispatch={dispatch}
                buttonRef={doneRef}
                variant={part.isMaker ? "primary" : "secondary"}
                pendingText="Saving…"
                label="Mark done"
                confirm={part.isMaker ? undefined : `Mark “${part.name}” done?`}
              >
                <CircleCheck className="size-4 shrink-0" aria-hidden />
              </OpButton>
            )}
            {part.canUnclaim && (
              <OpButton op="drop" part={part} dispatch={dispatch} buttonRef={dropRef} variant="secondary" pendingText="Dropping…" label="Drop it">
                <Undo2 className="size-4 shrink-0" aria-hidden />
              </OpButton>
            )}
          </div>
        )}
      </div>

      {showTools && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {part.canMove && (
            <div className="flex items-center gap-1.5" role="group" aria-label={`Queue place for ${part.name}`}>
              <MoveButton op="top" part={part} dispatch={dispatch} buttonRef={topRef} disabled={isFirst} />
              <MoveButton op="up" part={part} dispatch={dispatch} buttonRef={upRef} disabled={isFirst} />
              <MoveButton op="down" part={part} dispatch={dispatch} buttonRef={downRef} disabled={isLast} />
            </div>
          )}
          {part.canReopen && (
            <OpButton op="reopen" part={part} dispatch={dispatch} variant="secondary" pendingText="Putting back…" label="Put back in the queue">
              <RotateCcw className="size-4 shrink-0" aria-hidden />
            </OpButton>
          )}
          {part.canEdit && (
            // Icon-only squares on phones; with their words from `sm` up.
            <div className="ml-auto flex items-center gap-1">
              <Link
                href={`/parts/${part.id}/edit`}
                className={buttonClasses("ghost", "icon", "sm:w-auto sm:gap-2 sm:px-3")}
                aria-label={`Edit ${part.name}`}
                title="Edit"
              >
                <Pencil className="size-4 shrink-0" aria-hidden />
                <span className="hidden sm:inline">Edit</span>
              </Link>
              <OpButton
                op="remove"
                part={part}
                dispatch={dispatch}
                variant="ghost"
                label="Remove"
                ariaLabel={`Remove ${part.name}`}
                confirm={`Remove “${part.name}” from the parts queue?`}
                size="icon"
                className="sm:w-auto sm:gap-2 sm:px-3"
                title="Remove"
                hideLabelOnPhones
              >
                <Trash2 className="size-4 shrink-0 text-red-600" aria-hidden />
              </OpButton>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </article>
  );
}

/** Big "#1" (the top of the queue stands out), or a check mark on the Done tab. */
function RankMark({ rank, done }: { rank: number | null; done: boolean }) {
  if (done || rank === null) {
    return (
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
        <CircleCheck className="size-5" aria-hidden />
      </span>
    );
  }
  return (
    <p
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-lg font-display text-xl font-semibold tabular-nums",
        rank === 1 ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-800",
      )}
    >
      <span className="sr-only">Number </span>
      <span aria-hidden className="mr-px text-sm">
        #
      </span>
      {rank}
    </p>
  );
}

function StatusLine({
  part,
  done,
  nowIso,
  timeZone,
  photoId,
}: {
  part: PartItem;
  done: boolean;
  nowIso: string;
  timeZone: string;
  /** The maker's portal photo, else initials. */
  photoId?: string | null;
}) {
  const now = new Date(nowIso);
  const ago = (iso: string | null) => (iso ? timeAgo(new Date(iso), now, timeZone) : null);
  if (done) {
    const when = ago(part.doneAt);
    return (
      <p className="flex min-w-0 items-center gap-2 text-sm text-ink-700">
        {part.claimedBy && <Avatar name={part.claimedBy.name} size="sm" photoId={photoId} />}
        <span className="min-w-0 wrap-anywhere">
          {part.claimedBy ? (
            <>
              Made by <span className="font-medium text-ink-900">{part.isMaker ? "you" : part.claimedBy.name}</span>
            </>
          ) : (
            // Finished by a Build leader without anyone grabbing it: nobody is recorded as its maker.
            "Marked done"
          )}
          {when && <span className="text-ink-500"> · {when}</span>}
        </span>
      </p>
    );
  }
  if (part.status === "NEEDED") {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-700">
        <span aria-hidden className="size-2 rounded-full bg-amber-400" />
        Up for grabs
      </p>
    );
  }
  const maker = part.isMaker ? "You're" : part.claimedBy ? `${part.claimedBy.name} is` : "Someone is";
  const since = ago(part.claimedAt);
  return (
    <p className="flex min-w-0 items-center gap-2 text-sm text-ink-700">
      {part.claimedBy && <Avatar name={part.claimedBy.name} size="sm" photoId={photoId} />}
      <span className="min-w-0 wrap-anywhere">
        <span className="font-medium text-ink-900">{maker}</span> making it
        {since && <span className="text-ink-500"> · {since}</span>}
      </span>
    </p>
  );
}

function PartNotes({ notes }: { notes: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = notes.length > LONG_NOTES || notes.split("\n").length > 3;
  return (
    <div className="mt-2">
      <div id={id}>
        <RichText text={notes} className={cn("text-sm text-ink-700 wrap-anywhere", long && !open && "line-clamp-3")} />
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="-ml-2 inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
        >
          {open ? "Show less" : "Show all notes"}
        </button>
      )}
    </div>
  );
}

/** A one-button form posting `op` (and the part) to the card's action. */
function OpButton({
  op,
  part,
  dispatch,
  buttonRef,
  variant,
  pendingText,
  label,
  ariaLabel,
  confirm,
  size = "md",
  className,
  title,
  hideLabelOnPhones = false,
  children,
}: {
  op: PartOp;
  part: PartItem;
  dispatch: (formData: FormData) => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  variant: ButtonVariant;
  pendingText?: string;
  label: string;
  /** Defaults to "<label>: <part name>" so every card's buttons are distinct for screen readers. */
  ariaLabel?: string;
  confirm?: string;
  size?: ButtonSize;
  className?: string;
  title?: string;
  hideLabelOnPhones?: boolean;
  /** The icon. */
  children: ReactNode;
}) {
  return (
    <form action={dispatch} className="inline-flex">
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="partId" value={part.id} />
      <SubmitButton
        ref={buttonRef}
        variant={variant}
        pendingText={pendingText}
        confirm={confirm}
        aria-label={ariaLabel ?? `${label}: ${part.name}`}
        size={size}
        title={title}
        className={cn(FOCUS_SCROLL_MARGIN, className)}
      >
        {children}
        <span className={cn(hideLabelOnPhones && "hidden sm:inline")}>{label}</span>
      </SubmitButton>
    </form>
  );
}

const MOVE_ICONS = { up: ArrowUp, down: ArrowDown, top: ArrowUpToLine } as const;
const MOVE_WORDS = { up: "up", down: "down", top: "to the top" } as const;

function MoveButton({
  op,
  part,
  dispatch,
  buttonRef,
  disabled,
}: {
  op: "up" | "down" | "top";
  part: PartItem;
  dispatch: (formData: FormData) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
}) {
  const Icon = MOVE_ICONS[op];
  const label = `Move ${part.name} ${MOVE_WORDS[op]}`;
  if (disabled) {
    return (
      <Button ref={buttonRef} variant="secondary" size="icon" disabled aria-label={label}>
        <Icon className="size-4 shrink-0" aria-hidden />
      </Button>
    );
  }
  return (
    <form action={dispatch} className="inline-flex">
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="partId" value={part.id} />
      <input type="hidden" name="direction" value={op} />
      <SubmitButton
        ref={buttonRef}
        variant="secondary"
        size="icon"
        aria-label={label}
        title={`Move ${MOVE_WORDS[op]}`}
        className={FOCUS_SCROLL_MARGIN}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
      </SubmitButton>
    </form>
  );
}
