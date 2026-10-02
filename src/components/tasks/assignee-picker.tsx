"use client";

import { Search, UserPlus, X } from "lucide-react";
import { useId, useState } from "react";
import type { Subteam } from "@/generated/prisma/enums";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { cn } from "@/lib/cn";
import type { AssignablePerson, AssigneeGroup } from "@/server/queries/tasks";
import { RoleBadge } from "../app/badges";
import { FieldError } from "../ui/field";

const smallButton =
  "inline-flex h-10 items-center rounded-lg px-2.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-ink-300 disabled:hover:bg-transparent";

function matches(name: string, query: string) {
  return name.toLowerCase().includes(query);
}

/**
 * Pick the people a task is assigned to. Renders one `<input type="checkbox" name="assigneeIds">`
 * per person (all of them stay in the form while searching, so hidden selections still submit).
 */
export function AssigneePicker({
  groups,
  defaultSelected = [],
  taskSubteam,
  error,
  name = "assigneeIds",
  label = "Assign to",
  optional = false,
  hint,
  maxSelected = null,
  onSelectionChange,
}: {
  groups: AssigneeGroup[];
  defaultSelected?: string[];
  /** The task's subteam as chosen in the form ("" = whole team), for the quick-select shortcut. */
  taskSubteam?: "" | Subteam;
  error?: string;
  name?: string;
  /** Heading of the picker (e.g. "Already on it" for sign-up tasks). */
  label?: string;
  /** Adds a light "(optional)" after the label, like other optional fields. */
  optional?: boolean;
  /** Short explanation under the heading (read out with the group). */
  hint?: string;
  /** Most people who can be picked (a sign-up task's spots). "Select all" won't go past it. Null = no limit. */
  maxSelected?: number | null;
  onSelectionChange?: (ids: Set<string>) => void;
}) {
  const baseId = useId();
  // Locked people (e.g. a leader who can't remove themselves) are always selected.
  const lockedIds = groups.flatMap((g) => g.people).filter((p) => p.locked).map((p) => p.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set([...defaultSelected, ...lockedIds]));
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const update = (fn: (next: Set<string>) => void) => {
    const next = new Set(selected);
    fn(next);
    lockedIds.forEach((id) => next.add(id));
    setSelected(next);
    onSelectionChange?.(next);
  };
  const toggle = (id: string, on: boolean) => update((s) => (on ? s.add(id) : s.delete(id)));
  const addAll = (ids: string[]) => update((s) => ids.forEach((id) => s.add(id)));
  const removeAll = (ids: string[]) => update((s) => ids.forEach((id) => s.delete(id)));

  const everyone = groups.flatMap((g) => g.people);
  const visibleCount = q ? everyone.filter((p) => matches(p.name, q)).length : everyone.length;

  /** Bulk buttons add only people who can be added (no note, not frozen). */
  const addable = (p: AssignablePerson) => !p.note && !p.frozen;

  // Shortcut for staff who can see several groups: "Select everyone in Build" when the task is a Build task.
  let shortcut: { label: string; ids: string[] } | null = null;
  if (groups.length > 1 && taskSubteam !== undefined) {
    if (taskSubteam === "") {
      shortcut = { label: "Select everyone", ids: everyone.filter(addable).map((p) => p.id) };
    } else {
      const group = groups.find((g) => g.key === taskSubteam);
      if (group) {
        shortcut = {
          label: `Select everyone in ${SUBTEAM_LABELS[taskSubteam]}`,
          ids: group.people.filter(addable).map((p) => p.id),
        };
      }
    }
    if (shortcut && (shortcut.ids.length === 0 || shortcut.ids.every((id) => selected.has(id)))) shortcut = null;
  }

  // With a spot limit, bulk buttons only show when everything they'd add still fits.
  const fits = (ids: string[]) => maxSelected === null || new Set([...selected, ...ids]).size <= maxSelected;
  if (shortcut && !fits(shortcut.ids)) shortcut = null;
  const overLimit = maxSelected !== null && selected.size > maxSelected;

  const errorId = `${baseId}-error`;
  const hintId = `${baseId}-hint`;
  const limitId = `${baseId}-limit`;
  const describedBy = [hint && hintId, overLimit && limitId, error && errorId].filter(Boolean).join(" ") || undefined;

  return (
    <fieldset aria-describedby={describedBy} className="min-w-0 space-y-3">
      <legend className="sr-only">
        {label}
        {optional && " (optional)"}
      </legend>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-hidden className="text-sm font-medium text-ink-800">
          {label}
          {optional && <span className="font-normal text-ink-500"> (optional)</span>}
        </p>
        <div className="flex items-center gap-1">
          <span className="text-sm tabular-nums text-ink-600" aria-live="polite">
            <span className="font-semibold text-ink-900">{selected.size}</span> selected
          </span>
          {selected.size > lockedIds.length && (
            <button type="button" className={smallButton} onClick={() => removeAll([...selected])}>
              Clear all
            </button>
          )}
        </div>
      </div>

      {hint && (
        <p id={hintId} className="-mt-2 text-xs text-ink-500">
          {hint}
        </p>
      )}
      {overLimit && (
        <p id={limitId} className="text-xs text-amber-800">
          That&apos;s more people than spots ({maxSelected}). Raise Spots or uncheck someone.
        </p>
      )}

      {shortcut && (
        <button
          type="button"
          onClick={() => addAll(shortcut.ids)}
          className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-brand-300 bg-brand-50/60 px-3 py-2 text-sm font-medium text-brand-800 transition-colors hover:bg-brand-50"
        >
          <UserPlus className="size-4" aria-hidden />
          {shortcut.label} ({shortcut.ids.length})
        </button>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name"
          aria-label="Search people by name"
          autoComplete="off"
          className="block h-10 w-full rounded-lg border border-ink-200 bg-white pl-9 pr-10 text-sm text-ink-900 shadow-sm placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-0 top-0 inline-flex size-10 items-center justify-center text-ink-400 hover:text-ink-700"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      <div className={cn("divide-y divide-ink-200 overflow-hidden rounded-lg border bg-white", error ? "border-red-400" : "border-ink-200")}>
        {groups.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink-500">There&apos;s nobody you can assign yet.</p>}
        {groups.map((group) => {
          const visible = group.people.filter((p) => !q || matches(p.name, q));
          const visibleIds = visible.filter((p) => addable(p) || selected.has(p.id)).map((p) => p.id);
          const chosen = group.people.filter((p) => selected.has(p.id)).length;
          const headingId = `${baseId}-${group.key}`;
          return (
            <section key={group.key} aria-labelledby={headingId} className={visible.length === 0 ? "hidden" : undefined}>
              <div className="flex items-center justify-between gap-2 bg-ink-50 py-0.5 pl-3 pr-1">
                <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-ink-600">
                  {group.label}{" "}
                  <span className="font-normal normal-case tracking-normal text-ink-500">
                    {chosen}/{group.people.length}
                  </span>
                </h3>
                <div className="flex shrink-0">
                  {fits(visibleIds) && (
                    <button
                      type="button"
                      className={smallButton}
                      disabled={visibleIds.every((id) => selected.has(id))}
                      onClick={() => addAll(visibleIds)}
                    >
                      Select all
                    </button>
                  )}
                  <button
                    type="button"
                    className={smallButton}
                    disabled={!visible.some((p) => selected.has(p.id) && !p.locked)}
                    onClick={() => removeAll(visible.map((p) => p.id))}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <ul className="divide-y divide-ink-100">
                {group.people.map((person) => {
                  const shown = !q || matches(person.name, q);
                  const checked = selected.has(person.id);
                  const disabled = !!person.locked || (!!person.frozen && !checked);
                  return (
                    <li key={person.id} className={shown ? undefined : "hidden"}>
                      <label
                        className={cn(
                          "flex min-h-11 items-center gap-3 px-3 py-2 transition-colors",
                          disabled ? "cursor-default" : "cursor-pointer hover:bg-ink-50",
                          checked && "bg-brand-50/50",
                        )}
                      >
                        <input
                          type="checkbox"
                          name={person.locked ? undefined : name}
                          value={person.id}
                          checked={checked}
                          disabled={disabled}
                          onChange={(e) => toggle(person.id, e.target.checked)}
                          className="size-5 shrink-0 rounded border-ink-300 disabled:opacity-70"
                        />
                        {/* A disabled checkbox isn't submitted, so locked people go in a hidden input. */}
                        {person.locked && <input type="hidden" name={name} value={person.id} />}
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate text-sm font-medium", disabled && !checked ? "text-ink-400" : "text-ink-900")}>
                            {person.name}
                          </span>
                          {person.note && <span className="block text-xs text-amber-700">{person.note}</span>}
                        </span>
                        <RoleBadge role={person.role} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {groups.length > 0 && visibleCount === 0 && (
          <p className="px-3 py-6 text-center text-sm text-ink-500">No one matches &ldquo;{query.trim()}&rdquo;.</p>
        )}
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </fieldset>
  );
}
