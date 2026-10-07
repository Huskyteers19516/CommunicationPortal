"use client";

import { Check, LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { createMeetingCategoryAction, type MeetingCategoryCreateState } from "@/app/(app)/meetings/actions";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { catchUpMeetingCategories, findMeetingCategory, removedMeetingCategoriesText } from "@/lib/meeting-recap-view";
import { MEETING_CATEGORIES_MAX, MEETING_CATEGORIES_PER_RECAP_MAX, type MeetingCategoryOption } from "@/lib/meeting-recaps";
import { Button } from "../ui/button";
import { FieldError, Input, Label } from "../ui/field";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";
/** How long "Added “X”." stays. (That a picked category was deleted stays until the next change.) */
const MESSAGE_MS = 6000;
const PICKS_MAX = MEETING_CATEGORIES_PER_RECAP_MAX;

const byName = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

type Notice = { text: string; sticky?: boolean };
/** Where focus goes once the new category's box has closed: a category's checkbox, or "" for "New category…". */
type FocusRequest = { id: string };
/** A category to pick once the list has it (a name that was taken, found when the page's list caught up). */
type PickRequest = { id: string };

/** What to say about a name that's on the list already: still picked, picked now, or no room to pick it. */
function alreadyListedText(name: string, outcome: "picked" | "picks" | "full"): string {
  if (outcome === "picked") return `“${name}” is already on the list, and picked.`;
  if (outcome === "picks") return `“${name}” was already on the list, so it's picked now.`;
  return `“${name}” is already on the list. Untick a category to pick it (up to ${PICKS_MAX}).`;
}

export interface CategoryPickerProps {
  /** The team's categories (alphabetical or not: they're shown A–Z). */
  categories: MeetingCategoryOption[];
  /** The picked ids. */
  selected: string[];
  /**
   * Every change of the picked ids: ticking, unticking, a category added here (picked when there's room), and picks
   * dropped because their category was deleted meanwhile.
   */
  onChange: (ids: string[]) => void;
  /** The checkboxes' form field name (default `categoryIds`, what the recap actions read). */
  name?: string;
  /** The action's message for the field. */
  error?: string;
  /** Offer "New category…" (default true; people with admin access may add to the team's list). */
  canAdd?: boolean;
  /** Called with a category added here (after it's saved). */
  onAdded?: (category: MeetingCategoryOption) => void;
  disabled?: boolean;
}

/**
 * A recap's categories: checkbox chips (up to MEETING_CATEGORIES_PER_RECAP_MAX; the rest wait while 5 are picked) and
 * "New category…", which saves one to the team's list right away (createMeetingCategoryAction — not a nested form, so
 * it works inside the recap's form: Enter adds, Escape cancels) and picks it. A name that's on the list already is
 * picked instead. Controlled: the parent holds `selected`.
 *
 * The team's list can change under an open form (other admins add and delete categories). Categories added here stay
 * listed until the page's own list has them. When the page refreshes (after an add, and after an error that says the
 * list moved — a taken name, a deleted category on save), picks whose category was deleted are dropped and named, and
 * a name the server said was taken is picked once the fresh list shows it.
 */
export function CategoryPicker({
  categories,
  selected,
  onChange,
  name = "categoryIds",
  error,
  canAdd = true,
  onAdded,
  disabled = false,
}: CategoryPickerProps) {
  const id = useId();
  const router = useRouter();
  const [added, setAdded] = useState<MeetingCategoryOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [message, setMessage] = useState<Notice | null>(null);
  const [pending, startTransition] = useTransition();
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [pickRequest, setPickRequest] = useState<PickRequest | null>(null);
  // A name the server said is taken (added by someone else after this page loaded), until the refreshed list shows it.
  const [wanted, setWanted] = useState<string | null>(null);
  // The copy of the team's list last caught up with.
  const [seen, setSeen] = useState(categories);
  const inputRef = useRef<HTMLInputElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusedFor = useRef<FocusRequest | null>(null);
  const pickedFor = useRef<PickRequest | null>(null);
  // The newest picks, listeners and list, for a category that's saved after the person ticked something else meanwhile.
  const latest = useRef({ selected, onChange, onAdded, categories });
  useEffect(() => {
    latest.current = { selected, onChange, onAdded, categories };
  });

  // A fresh copy of the team's list (the page refreshed): catch up with it.
  if (seen !== categories) {
    const caught = catchUpMeetingCategories({ before: seen, next: categories, added, selected });
    setSeen(categories);
    if (caught.added.length !== added.length) setAdded(caught.added);
    const notes = caught.removed.length ? [removedMeetingCategoriesText(caught.removed)] : [];
    const found = wanted ? findMeetingCategory(categories, wanted) : undefined;
    if (found) {
      const already = caught.selected.includes(found.id);
      const room = caught.selected.length < PICKS_MAX;
      if (!already && room) setPickRequest({ id: found.id });
      notes.push(alreadyListedText(found.name, already ? "picked" : room ? "picks" : "full"));
      setWanted(null);
      setAdding(false);
      setDraft("");
      setAddError(null);
      setFocusRequest({ id: found.id });
    }
    if (notes.length) setMessage({ text: notes.join(" "), sticky: caught.removed.length > 0 });
  }

  const all = useMemo(() => {
    const byId = new Map<string, MeetingCategoryOption>();
    for (const c of [...categories, ...added]) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) => byName.compare(a.name, b.name));
  }, [categories, added]);
  const known = useMemo(() => new Set(all.map((c) => c.id)), [all]);
  // Picks that aren't on the list anymore don't count (they're dropped right away, below).
  const picks = selected.filter((s) => known.has(s));
  const full = picks.length >= PICKS_MAX;
  const listFull = all.length >= MEETING_CATEGORIES_MAX;

  // The picks follow the list: a deleted category is unpicked, and a taken name found on the list is picked.
  useEffect(() => {
    const now = latest.current;
    let next = now.selected.filter((s) => known.has(s));
    if (pickRequest && pickedFor.current !== pickRequest) {
      pickedFor.current = pickRequest;
      if (known.has(pickRequest.id) && !next.includes(pickRequest.id) && next.length < PICKS_MAX) next = [...next, pickRequest.id];
    }
    if (next.length !== now.selected.length || next.some((s, i) => s !== now.selected[i])) now.onChange(next);
  }, [known, pickRequest]);

  // The recap's save says a picked category is gone (deleted by someone else): refresh the list, so it's unpicked and named.
  useEffect(() => {
    if (error) router.refresh();
  }, [error, router]);

  useEffect(() => {
    if (!message || message.sticky) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  // Once the new category's box has closed: focus the category it was about, or "New category…" — whichever can take
  // focus (a category that couldn't be picked is a disabled box) — else the first picked box, else the message.
  useEffect(() => {
    if (adding || !focusRequest || focusedFor.current === focusRequest) return;
    focusedFor.current = focusRequest;
    const box = (categoryId: string) => document.getElementById(`${id}-${categoryId}`) as HTMLInputElement | null;
    const firstPicked = latest.current.selected.map(box).find(Boolean) ?? null;
    const target = [focusRequest.id ? box(focusRequest.id) : null, newButtonRef.current, firstPicked].find((el) => el && !el.disabled);
    (target ?? statusRef.current)?.focus();
  }, [adding, focusRequest, all, id]);

  function toggle(categoryId: string, on: boolean) {
    if (message?.sticky) setMessage(null);
    const others = picks.filter((s) => s !== categoryId);
    onChange(on ? [...others, categoryId] : others);
  }

  function close(focusId = "") {
    setFocusRequest({ id: focusId });
    setAdding(false);
    setDraft("");
    setAddError(null);
    setWanted(null);
  }

  /** A name that's on the list already: pick that category (when there's room) instead of adding it again. */
  function pickListed(category: MeetingCategoryOption) {
    const already = picks.includes(category.id);
    const room = picks.length < PICKS_MAX;
    if (!already && room) onChange([...picks, category.id]);
    setMessage({ text: alreadyListedText(category.name, already ? "picked" : room ? "picks" : "full") });
    close(category.id);
  }

  function add() {
    if (pending) return;
    const typed = draft.replace(/\s+/g, " ").trim();
    if (!typed) {
      setAddError("Type a name for the category.");
      inputRef.current?.focus();
      return;
    }
    const listed = findMeetingCategory(all, typed);
    if (listed) {
      pickListed(listed);
      return;
    }
    const fd = new FormData();
    fd.set("name", typed);
    setWanted(null);
    startTransition(async () => {
      let result: MeetingCategoryCreateState;
      try {
        result = await createMeetingCategoryAction(null, fd);
      } catch {
        setAddError(OFFLINE_MESSAGE);
        return;
      }
      if (!result?.ok || !result.categoryId) {
        setAddError(result?.fieldErrors?.name ?? result?.message ?? OFFLINE_MESSAGE);
        inputRef.current?.focus();
        // The list may have moved since the page loaded (someone else added this name, or filled the list): refresh
        // it. A name that's taken is picked once the fresh list shows it.
        setWanted(typed);
        router.refresh();
        return;
      }
      const category = { id: result.categoryId, name: result.name ?? typed };
      const now = latest.current;
      // Listed here until the page's own list has it (its refresh may arrive after this answer).
      if (!now.categories.some((c) => c.id === category.id)) setAdded((list) => [...list.filter((c) => c.id !== category.id), category]);
      const room = now.selected.length < PICKS_MAX;
      if (room && !now.selected.includes(category.id)) now.onChange([...now.selected, category.id]);
      now.onAdded?.(category);
      setMessage({
        text: room
          ? `Added “${category.name}” and picked it.`
          : `Added “${category.name}”. Untick a category to pick it (up to ${PICKS_MAX}).`,
      });
      close(category.id);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      // Not the recap's form: Enter adds the category.
      e.preventDefault();
      add();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <fieldset aria-describedby={error ? errorId : hintId} disabled={disabled} className="min-w-0">
      <legend className="text-sm font-medium text-ink-800">
        Categories <span className="font-normal text-ink-500">(optional)</span>
      </legend>
      <p id={hintId} className="mt-0.5 text-xs text-ink-500">
        {full ? `That's ${PICKS_MAX}, the most a recap can have. Untick one to pick another.` : `Pick up to ${PICKS_MAX}.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {all.map((c, i) => {
          const checked = picks.includes(c.id);
          return (
            <label
              key={c.id}
              className={cn(
                "inline-flex h-10 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors",
                checked ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
                error && !checked && "border-red-300",
                !checked && full && "cursor-not-allowed opacity-60 hover:bg-white",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40",
              )}
            >
              <input
                id={`${id}-${c.id}`}
                type="checkbox"
                name={name}
                value={c.id}
                checked={checked}
                disabled={!checked && full}
                onChange={(e) => toggle(c.id, e.currentTarget.checked)}
                // Checkboxes in a group can't take aria-invalid here; this marks where focus goes after an error.
                data-invalid={error && i === 0 ? "true" : undefined}
                className="sr-only"
              />
              {checked && <Check className="size-4 shrink-0" aria-hidden />}
              <span className="truncate">{c.name}</span>
            </label>
          );
        })}
        {canAdd && !adding && !listFull && (
          <button
            ref={newButtonRef}
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex h-10 items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-3.5 text-sm font-medium text-brand-700 transition-colors hover:border-brand-400 hover:bg-brand-50"
          >
            <Plus className="size-4" aria-hidden />
            New category…
          </button>
        )}
      </div>
      {all.length === 0 && !adding && <p className="mt-2 text-sm text-ink-500">No categories yet.</p>}

      {adding && (
        <div className="mt-3 space-y-1.5 rounded-lg border border-ink-200 bg-ink-50/60 p-3">
          <Label htmlFor={`${id}-new`}>New category</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              ref={inputRef}
              id={`${id}-new`}
              value={draft}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
                setWanted(null);
              }}
              onKeyDown={onKeyDown}
              maxLength={LIMITS.categoryNameMax}
              placeholder="e.g. Drive team"
              autoComplete="off"
              autoFocus
              enterKeyHint="done"
              invalid={!!addError}
              aria-describedby={`${addError ? `${id}-new-error ` : ""}${id}-new-hint`}
              className="min-w-40 flex-[1_1_10rem]"
            />
            <Button onClick={add} aria-busy={pending} className={cn("shrink-0", pending && "cursor-wait opacity-60")}>
              {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              {pending ? "Adding…" : "Add"}
            </Button>
            <Button variant="ghost" onClick={() => close()} className="shrink-0">
              Cancel
            </Button>
          </div>
          <FieldError id={`${id}-new-error`}>{addError}</FieldError>
          <p id={`${id}-new-hint`} className="text-xs text-ink-500">
            It&apos;s added to the team&apos;s list right away, for every recap.
            {full && ` This recap has ${PICKS_MAX} categories already, the most it can have, so the new one won't be picked.`}
          </p>
        </div>
      )}
      {canAdd && listFull && (
        <p className="mt-2 text-xs text-ink-500">The team&apos;s list has {MEETING_CATEGORIES_MAX} categories, the most it can have.</p>
      )}

      <FieldError id={errorId}>{error}</FieldError>
      {/* Always on the page, so screen readers announce it; focus lands here when nothing else near can take it. */}
      <p ref={statusRef} role="status" tabIndex={-1} className="mt-1.5 text-sm text-brand-700 empty:mt-0 focus:outline-none">
        {message?.text}
      </p>
    </fieldset>
  );
}
