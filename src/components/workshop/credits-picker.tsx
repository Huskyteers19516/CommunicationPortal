"use client";

import { Search, X } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { WORKSHOP_LIMITS } from "@/lib/workshop";
import type { WorkshopPerson } from "@/server/queries/workshop";
import { FieldError } from "../ui/field";

/**
 * Who designed or built a project: a searchable checkbox list of everyone with an account. Names are shown (here and
 * on the website) in the order they were ticked, so the checkboxes have no name; the picked ids are sent in that
 * order as hidden `creditIds` fields. At most WORKSHOP_LIMITS.creditsMax.
 */
export function CreditsPicker({
  people,
  selected,
  onChange,
  error,
}: {
  people: WorkshopPerson[];
  /** Picked ids, in order. */
  selected: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  const baseId = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const max = WORKSHOP_LIMITS.creditsMax;
  const atMax = selected.length >= max;
  const byId = new Map(people.map((p) => [p.id, p]));
  const picked = selected.map((id) => byId.get(id)).filter((p): p is WorkshopPerson => !!p);
  const visible = q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;

  const toggle = (id: string, on: boolean) => onChange(on ? (selected.includes(id) ? selected : [...selected, id]) : selected.filter((s) => s !== id));

  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const countId = `${baseId}-count`;

  return (
    <fieldset aria-describedby={[hintId, error && errorId].filter(Boolean).join(" ")} className="min-w-0 space-y-3">
      <legend className="sr-only">Credits (optional)</legend>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p aria-hidden className="text-sm font-medium text-ink-800">
          Credits <span className="font-normal text-ink-500">(optional)</span>
        </p>
        <p id={countId} className="text-sm tabular-nums text-ink-600" aria-live="polite">
          <span className="font-semibold text-ink-900">{selected.length}</span> of {max} picked
        </p>
      </div>
      <p id={hintId} className="-mt-2 text-xs text-ink-500">
        Who designed or built it. Names show in the order you pick them.
      </p>

      {selected.map((id) => (
        <input key={id} type="hidden" name="creditIds" value={id} />
      ))}

      {picked.length > 0 && (
        <ol className="flex flex-wrap gap-2" aria-label="Credited, in order">
          {picked.map((p, i) => (
            <li
              key={p.id}
              className="inline-flex h-10 max-w-full items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 pl-3 text-sm text-brand-900"
            >
              <span className="text-xs font-semibold tabular-nums text-brand-700">{i + 1}.</span>
              <span className="min-w-0 truncate">{p.name}</span>
              <button
                type="button"
                onClick={() => toggle(p.id, false)}
                aria-label={`Remove ${p.name}`}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-brand-700 hover:bg-brand-100"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter here would send the whole form.
            if (e.key === "Enter") e.preventDefault();
          }}
          placeholder="Search by name"
          aria-label="Search people by name"
          autoComplete="off"
          className="block h-10 w-full rounded-lg border border-ink-200 bg-white pl-9 pr-10 text-sm [&::-webkit-search-cancel-button]:appearance-none text-ink-900 shadow-sm placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
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

      <ul
        className={cn(
          "max-h-72 divide-y divide-ink-100 overflow-y-auto rounded-lg border bg-white",
          error ? "border-red-400" : "border-ink-200",
        )}
      >
        {visible.map((person) => {
          const checked = selected.includes(person.id);
          const disabled = !checked && atMax;
          return (
            <li key={person.id}>
              <label
                className={cn(
                  "flex min-h-11 items-center gap-3 px-3 py-2 transition-colors",
                  disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-ink-50",
                  checked && "bg-brand-50/50",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => toggle(person.id, e.target.checked)}
                  aria-invalid={error ? true : undefined}
                  className="size-5 shrink-0 rounded border-ink-300 disabled:opacity-50"
                />
                <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", disabled ? "text-ink-400" : "text-ink-900")}>
                  {person.name}
                </span>
                {checked && (
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-brand-700">#{selected.indexOf(person.id) + 1}</span>
                )}
              </label>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-ink-500">
            {q ? <>No one matches &ldquo;{query.trim()}&rdquo;.</> : "There's nobody to credit yet."}
          </li>
        )}
      </ul>
      {atMax && <p className="text-xs text-amber-800">That&apos;s the most people a project can credit. Add anyone else under Other people.</p>}
      <FieldError id={errorId}>{error}</FieldError>
    </fieldset>
  );
}
