"use client";

import { Search, UserMinus, UserPlus } from "lucide-react";
import { Fragment, startTransition, useActionState, useEffect, useId, useOptimistic, useRef, useState } from "react";
import { addPersonAction, removePersonAction, setCreditAction } from "@/app/(app)/attendance/actions";
import type { AttendanceKind, CheckInMethod, Subteam } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { adminCreditOptions, creditMenuGroups, type CreditOption, type CreditOptionId } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { Button } from "../ui/button";
import { Input, Select } from "../ui/field";
import { WeekPill } from "./week-progress";

export interface RosterRow {
  id: string;
  name: string;
  subteam: Subteam | null;
  method: CheckInMethod;
  /** Already formatted in the team timezone, e.g. "3:05 PM". */
  time: string;
  markedByName: string | null;
  /** The credit option it counts as (null for a value no option has) and its label ("1/2 EC"). */
  option: CreditOptionId | null;
  creditLabel: string;
  /** In sixths (0 = "No credit"). */
  credit: number;
  /** An admin (not the person) changed it after it was saved. */
  creditChangedByName: string | null;
  /** Their credits this week (sixths), this check-in included. */
  week: number;
}

export interface PersonRow {
  id: string;
  name: string;
  subteam: Subteam | null;
}

const METHOD_SHORT: Record<CheckInMethod, string> = { QR: "Scanned", CODE: "Typed code", MANUAL: "Added by hand" };
const SEARCH_RESULTS_MAX = 8;
/** What "People you add count as" starts at. */
const DEFAULT_HAND_OPTION: CreditOptionId = "1/2";

function subteamText(subteam: Subteam | null) {
  return subteam ? SUBTEAM_LABELS[subteam] : "No subteam";
}

function matches(name: string, query: string) {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().split(/\s+/).some((part) => part.startsWith(q)) || name.toLowerCase().includes(q);
}

/** Menu options, grouped at Flex ("Flex" / "Regular credit", No credit last). */
function menuOptions(kind: AttendanceKind, options: CreditOption[]) {
  return creditMenuGroups(kind, options).map((g, i) => {
    const items = g.options.map((o) => (
      <option key={o.id} value={o.id}>
        {o.label}
      </option>
    ));
    return g.label ? (
      <optgroup key={g.label} label={g.label}>
        {items}
      </optgroup>
    ) : (
      <Fragment key={`plain-${i}`}>{items}</Fragment>
    );
  });
}

/**
 * Who's on a session's list, for admins (any session, any time): each person with how much it counts — a menu
 * with only the options this admin may set on that record (adminCreditOptions: a scan can be anything that fits the
 * session or less; added by hand only 1/3, 1/2, 2/3, EC, or No credit; EC only for those who may give it; at Flex
 * grouped into Flex and regular credit) — their week so far ("1⅔ of 2"), and Remove. The admin's own row shows its
 * credit without a menu (another admin changes it), and they can't add themselves. People marked "No credit" are
 * listed apart. Below: adding someone by hand ("People you add count as", 1/2 to start). One status line says what
 * happened; after a row goes away, focus moves to the search box (adding, which also clears it) or the list's
 * heading (removing), never to <body>; a credit menu keeps focus.
 */
export function SessionPeople({
  sessionId,
  kind,
  weeklyTarget,
  weekLabel,
  roster,
  others,
  canGiveExtraCredit,
  actorId,
}: {
  sessionId: string;
  kind: AttendanceKind;
  weeklyTarget: number;
  /** "Sep 21 – Sep 27": the week the totals are for. */
  weekLabel: string;
  roster: RosterRow[];
  others: PersonRow[];
  canGiveExtraCredit: boolean;
  /** The admin looking (their own credit and adding themselves are for another admin). */
  actorId: string;
}) {
  const [query, setQuery] = useState("");
  const handOptions = adminCreditOptions({ kind, method: "MANUAL", canGiveExtraCredit });
  const [addAs, setAddAs] = useState<CreditOptionId>(DEFAULT_HAND_OPTION);
  const [addState, addAction, adding] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await addPersonAction(prev, formData);
    if (result?.ok) setQuery("");
    return result;
  }, initialActionState);
  const [removeState, removeAction, removing] = useActionState(removePersonAction, initialActionState);
  const [creditState, creditAction, changing] = useActionState(setCreditAction, initialActionState);
  // Picked before the server answers (and the page refreshes): person id → option.
  const [picked, setPicked] = useOptimistic<Record<string, CreditOptionId>, { userId: string; option: CreditOptionId }>(
    {},
    (current, { userId, option }) => ({ ...current, [userId]: option }),
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const rosterHeadingRef = useRef<HTMLHeadingElement>(null);
  const id = useId();

  const addNonce = addState?.nonce ?? 0;
  const removeNonce = removeState?.nonce ?? 0;
  const creditNonce = creditState?.nonce ?? 0;
  const latestNonce = Math.max(addNonce, removeNonce, creditNonce);
  const latest: ActionState =
    latestNonce === 0 ? null : latestNonce === addNonce ? addState : latestNonce === removeNonce ? removeState : creditState;

  useEffect(() => {
    if (!addNonce) return;
    searchRef.current?.focus();
  }, [addNonce]);
  useEffect(() => {
    if (!removeNonce) return;
    rosterHeadingRef.current?.focus();
  }, [removeNonce]);
  useEffect(() => {
    // A row that moved between "Checked in" and "Marked as not here" took its menu (and focus) with it.
    if (creditNonce && (document.activeElement === null || document.activeElement === document.body)) rosterHeadingRef.current?.focus();
  }, [creditNonce]);

  function send(action: (formData: FormData) => void, userId: string, extra: Record<string, string> = {}) {
    const formData = new FormData();
    formData.set("sessionId", sessionId);
    formData.set("userId", userId);
    for (const [k, v] of Object.entries(extra)) formData.set(k, v);
    startTransition(() => action(formData));
  }

  /** `from`: what the menu showed, so a change made meanwhile (by them or another admin) isn't overwritten unseen. */
  function changeCredit(userId: string, option: CreditOptionId, from: CreditOptionId | "") {
    const formData = new FormData();
    formData.set("sessionId", sessionId);
    formData.set("userId", userId);
    formData.set("option", option);
    formData.set("from", from);
    startTransition(() => {
      setPicked({ userId, option });
      creditAction(formData);
    });
  }

  const add = (userId: string) => send(addAction, userId, { option: addAs });
  const results = query.trim() ? others.filter((p) => p.id !== actorId && matches(p.name, query)).slice(0, SEARCH_RESULTS_MAX) : [];
  const busy = adding || removing || changing;
  const here = roster.filter((r) => r.credit > 0);
  const notHere = roster.filter((r) => r.credit <= 0);

  /** One person's row (a plain function, not a component: the rows must keep their elements, so a menu keeps focus). */
  function renderRow(r: RosterRow) {
    const value: CreditOptionId | "" = (picked[r.id] as CreditOptionId | undefined) ?? r.option ?? "";
    const options = adminCreditOptions({ kind, method: r.method, canGiveExtraCredit });
    // What it is now, when this admin can't pick it (EC, or a value no option has): shown, not offered.
    const current = options.some((o) => o.id === value) ? null : value;
    return (
      <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:px-4">
        <div className="min-w-0 flex-1 basis-36">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-ink-900">
            <span className="min-w-0 wrap-anywhere">{r.name}</span>
            {r.credit > 0 && <WeekPill total={r.week} target={weeklyTarget} />}
          </p>
          <p className="text-xs text-ink-500">
            {subteamText(r.subteam)} · {METHOD_SHORT[r.method]}
            {r.method === "MANUAL" && r.markedByName ? ` by ${r.markedByName}` : ""} · {r.time}
          </p>
          {r.creditChangedByName && <p className="text-xs text-ink-500 wrap-anywhere">Credit changed by {r.creditChangedByName}</p>}
          {r.id === actorId && <p className="text-xs text-ink-500">That&apos;s you: another admin changes your credit.</p>}
        </div>
        <div className="flex items-center gap-1">
          {/* The kit's Select is full width: the wrapper sets its size (wide enough for "No credit" at 16px). */}
          <div className="w-36 shrink-0">
            {r.id === actorId ? (
              <p className="flex h-10 items-center rounded-lg border border-ink-200 bg-ink-50 px-3 text-sm text-ink-800">
                <span className="sr-only">Your credit: </span>
                {r.creditLabel}
              </p>
            ) : (
              <Select
                aria-label={`Credit for ${r.name}`}
                value={value}
                onChange={(e) => changeCredit(r.id, e.currentTarget.value as CreditOptionId, value)}
              >
                {current !== null && (
                  <option value={current} disabled>
                    {r.creditLabel}
                  </option>
                )}
                {menuOptions(kind, options)}
              </Select>
            )}
          </div>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove ${r.name}`}
            title="Remove"
            onClick={() => {
              if (window.confirm(`Take ${r.name} off the list?`)) send(removeAction, r.id);
            }}
          >
            <UserMinus className="size-4" aria-hidden />
          </Button>
        </div>
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <p role="status" className={cn("min-h-5 text-sm font-medium", latest && !latest.ok ? "text-red-600" : "text-brand-800")}>
        {busy ? "Saving…" : (latest?.message ?? "")}
      </p>

      <section aria-labelledby={`${id}-roster`} className="space-y-2">
        <h2 id={`${id}-roster`} ref={rosterHeadingRef} tabIndex={-1} className="text-base font-semibold text-ink-900 focus:outline-none">
          On the list <span className="font-normal text-ink-500">({here.length})</span>
        </h2>
        {here.length > 0 && (
          <p className="text-xs text-ink-500">
            Next to each name: their total for the week of {weekLabel}, out of {weeklyTarget}.
          </p>
        )}
        {here.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-200 px-4 py-6 text-center text-sm text-ink-500">
            No one yet. People show up here as they scan in (or when an admin adds them).
          </p>
        ) : (
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white" aria-label="On the list">
            {here.map(renderRow)}
          </ul>
        )}
      </section>

      {notHere.length > 0 && (
        <section aria-labelledby={`${id}-not-here`} className="space-y-2">
          <h2 id={`${id}-not-here`} className="text-base font-semibold text-ink-900">
            Marked as not here <span className="font-normal text-ink-500">({notHere.length})</span>
          </h2>
          <p className="text-xs text-ink-500">No credit: on the sheet, but they count as not coming.</p>
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white" aria-label="Marked as not here">
            {notHere.map(renderRow)}
          </ul>
        </section>
      )}

      <section aria-labelledby={`${id}-add`} className="space-y-2">
        <h2 id={`${id}-add`} className="text-base font-semibold text-ink-900">
          Add someone by hand
        </h2>
        <p className="text-xs text-ink-500">
          For part of the practice{canGiveExtraCredit ? ", EC," : ""} or No credit. A full credit needs them to scan in.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label htmlFor={`${id}-add-as`} className="text-sm font-medium text-ink-800">
            People you add count as
          </label>
          <div className="w-36 shrink-0">
            <Select id={`${id}-add-as`} value={addAs} onChange={(e) => setAddAs(e.currentTarget.value as CreditOptionId)}>
              {menuOptions(kind, handOptions)}
            </Select>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search by name"
            aria-label="Search people to add"
            className="pl-9"
            autoComplete="off"
          />
        </div>
        {query.trim() !== "" &&
          (results.length === 0 ? (
            <p className="text-sm text-ink-500 wrap-anywhere">No one else matches “{query.trim()}”.</p>
          ) : (
            <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white" aria-label="People to add">
              {results.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
                  <div className="min-w-0 flex-1">
                    <p className="wrap-anywhere text-sm font-medium text-ink-900">{p.name}</p>
                    <p className="text-xs text-ink-500">{subteamText(p.subteam)}</p>
                  </div>
                  <Button size="md" variant="secondary" aria-label={`Add ${p.name}`} onClick={() => add(p.id)}>
                    <UserPlus className="size-4" aria-hidden />
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
}
