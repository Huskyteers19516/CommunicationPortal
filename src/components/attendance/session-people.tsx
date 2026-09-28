"use client";

import { Search, UserMinus, UserPlus } from "lucide-react";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { addPersonAction, removePersonAction } from "@/app/(app)/attendance/actions";
import type { CheckInMethod, RsvpAnswer, Subteam } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { RSVP_LABELS } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { Button } from "../ui/button";
import { Input } from "../ui/field";

export interface RosterRow {
  id: string;
  name: string;
  subteam: Subteam | null;
  method: CheckInMethod;
  /** Already formatted in the team timezone, e.g. "3:05 PM". */
  time: string;
  markedByName: string | null;
}

export interface PersonRow {
  id: string;
  name: string;
  subteam: Subteam | null;
  answer?: RsvpAnswer;
  note?: string;
}

const METHOD_SHORT: Record<CheckInMethod, string> = { QR: "Scanned", CODE: "Typed code", MANUAL: "Added by hand" };
const SEARCH_RESULTS_MAX = 8;

function subteamText(subteam: Subteam | null) {
  return subteam ? SUBTEAM_LABELS[subteam] : "No subteam";
}

function matches(name: string, query: string) {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().split(/\s+/).some((part) => part.startsWith(q)) || name.toLowerCase().includes(q);
}

/**
 * The live roster (with Remove) and adding people by hand: a search over everyone not on the list, plus quick
 * "Add" buttons for people who said they'd come. One status line says what happened; after a row goes away,
 * focus moves to the search box (adding, which also clears it) or the roster heading (removing), never to <body>.
 * `readOnly` (an old session this actor can't change): just the list.
 */
export function SessionPeople({
  sessionId,
  roster,
  expected,
  others,
  readOnly = false,
}: {
  sessionId: string;
  roster: RosterRow[];
  expected: PersonRow[];
  others: PersonRow[];
  readOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [addState, addAction, adding] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await addPersonAction(prev, formData);
    if (result?.ok) setQuery("");
    return result;
  }, initialActionState);
  const [removeState, removeAction, removing] = useActionState(removePersonAction, initialActionState);
  const searchRef = useRef<HTMLInputElement>(null);
  const rosterHeadingRef = useRef<HTMLHeadingElement>(null);
  const id = useId();

  const addNonce = addState?.nonce ?? 0;
  const removeNonce = removeState?.nonce ?? 0;
  const latest: ActionState = addNonce >= removeNonce ? addState : removeState;

  useEffect(() => {
    if (!addNonce) return;
    searchRef.current?.focus();
  }, [addNonce]);
  useEffect(() => {
    if (!removeNonce) return;
    rosterHeadingRef.current?.focus();
  }, [removeNonce]);

  function send(action: (formData: FormData) => void, userId: string) {
    const formData = new FormData();
    formData.set("sessionId", sessionId);
    formData.set("userId", userId);
    startTransition(() => action(formData));
  }

  const results = query.trim() ? others.filter((p) => matches(p.name, query)).slice(0, SEARCH_RESULTS_MAX) : [];
  const busy = adding || removing;

  return (
    <div className="space-y-6">
      <p role="status" className={cn("min-h-5 text-sm font-medium", latest && !latest.ok ? "text-red-600" : "text-brand-800")}>
        {busy ? "Saving…" : (latest?.message ?? "")}
      </p>

      <section aria-labelledby={`${id}-roster`} className="space-y-2">
        <h2 id={`${id}-roster`} ref={rosterHeadingRef} tabIndex={-1} className="text-base font-semibold text-ink-900 focus:outline-none">
          Checked in <span className="font-normal text-ink-500">({roster.length})</span>
        </h2>
        {roster.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-200 px-4 py-6 text-center text-sm text-ink-500">
            No one yet. People show up here as they scan.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white" aria-label="Checked in">
            {roster.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
                <div className="min-w-0 flex-1">
                  <p className="wrap-anywhere text-sm font-medium text-ink-900">{r.name}</p>
                  <p className="text-xs text-ink-500">
                    {subteamText(r.subteam)} · {METHOD_SHORT[r.method]}
                    {r.method === "MANUAL" && r.markedByName ? ` by ${r.markedByName}` : ""} · {r.time}
                  </p>
                </div>
                {!readOnly && (
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
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!readOnly && expected.length > 0 && (
        <section aria-labelledby={`${id}-expected`} className="space-y-2">
          <h2 id={`${id}-expected`} className="text-base font-semibold text-ink-900">
            Said they&apos;d come, not here yet <span className="font-normal text-ink-500">({expected.length})</span>
          </h2>
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white" aria-label="Said they'd come, not here yet">
            {expected.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
                <div className="min-w-0 flex-1">
                  <p className="wrap-anywhere text-sm font-medium text-ink-900">{p.name}</p>
                  <p className="wrap-anywhere text-xs text-ink-500">
                    {subteamText(p.subteam)}
                    {p.answer ? ` · ${RSVP_LABELS[p.answer]}` : ""}
                    {p.note ? ` · “${p.note}”` : ""}
                  </p>
                </div>
                <Button size="md" variant="secondary" aria-label={`Add ${p.name}`} onClick={() => send(addAction, p.id)}>
                  <UserPlus className="size-4" aria-hidden />
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!readOnly && <section aria-labelledby={`${id}-add`} className="space-y-2">
        <h2 id={`${id}-add`} className="text-base font-semibold text-ink-900">
          Add someone by hand
        </h2>
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
            <p className="text-sm text-ink-500">No one else matches “{query.trim()}”.</p>
          ) : (
            <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white" aria-label="People to add">
              {results.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
                  <div className="min-w-0 flex-1">
                    <p className="wrap-anywhere text-sm font-medium text-ink-900">{p.name}</p>
                    <p className="text-xs text-ink-500">{subteamText(p.subteam)}</p>
                  </div>
                  <Button size="md" variant="secondary" aria-label={`Add ${p.name}`} onClick={() => send(addAction, p.id)}>
                    <UserPlus className="size-4" aria-hidden />
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </section>}
    </div>
  );
}
