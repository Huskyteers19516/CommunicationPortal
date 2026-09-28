"use client";

import { ChevronDown, CircleCheck, TriangleAlert, Undo2 } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useId, useOptimistic, useRef, useState } from "react";
import { addPersonAction, removePersonAction } from "@/app/(app)/attendance/actions";
import type { AttendanceKind, RsvpAnswer, Subteam } from "@/generated/prisma/enums";
import { initialActionState } from "@/lib/action-state";
import { adminCreditOptions, ATTENDANCE_KIND_LABELS, type CreditOptionId, NO_CREDIT, RSVP_LABELS } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { Button } from "../ui/button";

export interface NoShowPerson {
  id: string;
  name: string;
  subteam: Subteam | null;
  answer: RsvpAnswer;
  note: string;
}

/** How many names the folded list shows ("A, B, C and 8 more"). */
const PREVIEW_NAMES = 3;

function preview(people: NoShowPerson[]): string {
  const names = people.slice(0, PREVIEW_NAMES).map((p) => p.name);
  const more = people.length - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more.` : `${names.join(", ")}.`;
}

/**
 * "Said they'd come — not checked in yet (N)": people who answered Yes / Half (Flex: Yes) and aren't on the list,
 * each with quick actions — give 1/3, 1/2, 2/3 (and EC for those who may give it), or No credit, set apart. Either
 * puts them on the sheet by hand (addPerson), so they leave the list. The row goes right away (shown before the
 * server answers), focus moves to the next person's first button (or the heading once nobody's left), and a status
 * line says what happened, with **Undo** (takes the hand entry off again while it's still that; focus goes back to
 * their row). The actor's own row has no buttons (nobody gives themselves credit). `collapsible` (while it's open:
 * people may still be on their way) starts folded to the names and a "Show list" button. Renders nothing while
 * nobody's missing; once everyone's dealt with, it says so.
 */
export function NoShowList({
  sessionId,
  kind,
  people,
  canGiveExtraCredit,
  actorId,
  live,
  title,
  description,
  headingLevel = 2,
  link,
  collapsible = false,
  className,
}: {
  sessionId: string;
  kind: AttendanceKind;
  people: NoShowPerson[];
  canGiveExtraCredit: boolean;
  /** The admin looking: their own row gets no buttons. */
  actorId: string;
  /** The session is open today (people can still scan in). */
  live: boolean;
  /** e.g. "Said they'd come — not checked in yet". The count is added. */
  title: string;
  description?: string;
  headingLevel?: 2 | 3;
  /** e.g. a link to the session's page. */
  link?: { href: string; label: string };
  /** Start folded (names only, "Show list"). */
  collapsible?: boolean;
  className?: string;
}) {
  const [addState, addAction, adding] = useActionState(addPersonAction, initialActionState);
  const [undoState, undoAction, undoing] = useActionState(removePersonAction, initialActionState);
  const [handled, hide] = useOptimistic<string[], string>([], (current, id) => [...current, id]);
  // Stays shown (saying everyone's been dealt with) once it had someone, so focus has somewhere to go.
  const [hadPeople, setHadPeople] = useState(people.length > 0);
  if (people.length > 0 && !hadPeople) setHadPeople(true);
  const [open, setOpen] = useState(!collapsible);
  /** The last quick action, for Undo. */
  const [last, setLast] = useState<{ id: string; name: string; option: CreditOptionId } | null>(null);
  const focusAfterUndo = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstButtons = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();

  const addNonce = addState?.nonce ?? 0;
  const undoNonce = undoState?.nonce ?? 0;
  // Undo brings their row back (with the page's refresh): focus its first button once it's there.
  useEffect(() => {
    const person = focusAfterUndo.current;
    if (!person) return;
    if (undoState && !undoState.ok) {
      focusAfterUndo.current = null;
      headingRef.current?.focus();
      return;
    }
    const el = firstButtons.current.get(person);
    if (el) {
      focusAfterUndo.current = null;
      el.focus();
    }
  }, [people, undoNonce, undoState]);

  if (!hadPeople) return null;
  const shown = people.filter((p) => !handled.includes(p.id));
  const actionable = shown.filter((p) => p.id !== actorId);
  const options = adminCreditOptions({ kind, method: "MANUAL", canGiveExtraCredit });
  const partial = options.filter((o) => o.id !== NO_CREDIT);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const latest = undoNonce > addNonce ? undoState : addState;
  const pending = adding || undoing;
  const error = latest && !latest.ok ? latest.message : "";
  const status = pending ? "Saving…" : error || (latest?.ok ? (latest.message ?? "") : "");
  // Undo right after a quick action worked (not after the Undo itself).
  const undoable = latest === addState && addState?.ok ? last : null;
  const expanded = open || !collapsible;

  function give(person: NoShowPerson, option: CreditOptionId) {
    const at = actionable.findIndex((p) => p.id === person.id);
    const next = actionable[at + 1] ?? actionable[at - 1];
    const formData = new FormData();
    formData.set("sessionId", sessionId);
    formData.set("userId", person.id);
    formData.set("option", option);
    setLast({ id: person.id, name: person.name, option });
    startTransition(() => {
      hide(person.id);
      addAction(formData);
    });
    // The row goes: keep focus in the list (the next person, else the heading).
    requestAnimationFrame(() => ((next ? firstButtons.current.get(next.id) : null) ?? headingRef.current)?.focus());
  }

  function undo() {
    if (!last || pending) return;
    const formData = new FormData();
    formData.set("sessionId", sessionId);
    formData.set("userId", last.id);
    formData.set("from", last.option);
    focusAfterUndo.current = last.id;
    setLast(null);
    setOpen(true);
    // The Undo button goes: hold focus on the heading until their row is back.
    headingRef.current?.focus();
    startTransition(() => undoAction(formData));
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        "space-y-3 rounded-xl border p-3 sm:p-4",
        shown.length > 0 ? "border-amber-300 bg-amber-50" : "border-brand-200 bg-brand-50",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Heading
          id={`${id}-title`}
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 text-base font-semibold text-ink-900 focus:outline-none"
        >
          {shown.length > 0 ? (
            <TriangleAlert className="size-5 shrink-0 text-amber-600" aria-hidden />
          ) : (
            <CircleCheck className="size-5 shrink-0 text-brand-600" aria-hidden />
          )}
          <span>
            {title} <span className="font-normal text-ink-600">({shown.length})</span>
          </span>
        </Heading>
        <div className="flex flex-wrap items-center gap-x-3">
          {link && (
            <Link href={link.href} className="inline-flex min-h-10 items-center text-sm font-medium text-brand-700 hover:underline">
              {link.label}
            </Link>
          )}
          {collapsible && shown.length > 0 && (
            <Button size="md" variant="secondary" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen(!open)}>
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
              {open ? "Hide list" : "Show list"}
            </Button>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-brand-800">Everyone who said they&apos;d come is on the list now.</p>
      ) : !expanded ? (
        <p className="text-sm text-amber-950 wrap-anywhere">{preview(shown)}</p>
      ) : (
        <>
          {description && <p className="text-sm text-amber-950">{description}</p>}
          <ul
            id={`${id}-list`}
            className="divide-y divide-ink-100 rounded-lg border border-amber-200 bg-white"
            aria-label={`${title} (${ATTENDANCE_KIND_LABELS[kind]})`}
          >
            {shown.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="wrap-anywhere text-sm font-medium text-ink-900">{p.name}</p>
                  <p className="wrap-anywhere text-xs text-ink-500">
                    {p.subteam ? SUBTEAM_LABELS[p.subteam] : "No subteam"} · Said {RSVP_LABELS[p.answer]}
                    {p.note ? ` · “${p.note}”` : ""}
                  </p>
                </div>
                {p.id === actorId ? (
                  <p className="text-sm text-ink-600 sm:text-right">
                    That&apos;s you. {live ? "Scan the code to check in." : "Ask another admin if you were there."}
                  </p>
                ) : (
                  <div role="group" aria-label={`What ${p.name} gets`} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                    <div className="flex flex-wrap gap-1.5">
                      {partial.map((o, i) => (
                        <Button
                          key={o.id}
                          ref={
                            i === 0
                              ? (el) => {
                                  if (el) firstButtons.current.set(p.id, el);
                                  else firstButtons.current.delete(p.id);
                                }
                              : undefined
                          }
                          size="md"
                          variant="secondary"
                          className="px-3"
                          aria-label={`Give ${p.name} ${o.label}`}
                          onClick={() => give(p, o.id)}
                        >
                          {o.label}
                        </Button>
                      ))}
                    </div>
                    {/* Apart from the credits (its own line on phones), so it isn't hit by mistake. */}
                    <div className="border-t border-ink-100 pt-2 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
                      <Button
                        size="md"
                        variant="secondary"
                        className="px-3 text-red-700"
                        aria-label={`${p.name}: No credit`}
                        onClick={() => give(p, NO_CREDIT)}
                      >
                        No credit
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
        <p role="status" className={cn("text-sm font-medium", error ? "text-red-600" : "text-brand-800")}>
          {status}
        </p>
        {undoable && (
          <Button
            size="md"
            variant="ghost"
            aria-disabled={pending || undefined}
            aria-label={`Undo: ${undoable.name}`}
            onClick={undo}
            className="px-2"
          >
            <Undo2 className="size-4" aria-hidden />
            Undo
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * Today (admins): today's sessions where people said they'd come and aren't on the list, each with the same quick
 * actions and a link to the session — folded to the names while it's open (they may still be on their way). Nothing
 * while nobody's missing.
 */
export function TodayNoShows({
  sessions,
  canGiveExtraCredit,
  actorId,
}: {
  sessions: { id: string; kind: AttendanceKind; open: boolean; people: NoShowPerson[] }[];
  canGiveExtraCredit: boolean;
  actorId: string;
}) {
  const any = sessions.some((s) => s.people.length > 0);
  const [shown, setShown] = useState(any);
  if (any && !shown) setShown(true);
  if (!shown) return null;
  return (
    <div className="space-y-3">
      {sessions.map((s) => {
        const kind = ATTENDANCE_KIND_LABELS[s.kind];
        return (
          <NoShowList
            key={s.id}
            sessionId={s.id}
            kind={s.kind}
            people={s.people}
            canGiveExtraCredit={canGiveExtraCredit}
            actorId={actorId}
            live={s.open}
            collapsible={s.open}
            headingLevel={2}
            className="shadow-sm"
            title={s.open ? `${kind}: said they'd come, not checked in yet` : `${kind}: said they'd come, didn't check in`}
            description={
              s.open
                ? "They may still be on their way: when they scan in, it counts as usual. Give part credit if they were there for some of it, or No credit."
                : "Give part credit if they were there for some of it, or No credit if they weren't."
            }
            link={{ href: `/attendance/sessions/${s.id}`, label: `Open ${kind}` }}
          />
        );
      })}
    </div>
  );
}
