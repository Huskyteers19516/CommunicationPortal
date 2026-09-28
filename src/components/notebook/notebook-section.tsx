"use client";

import { ChevronDown, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, type RefObject, useActionState, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  createNotebookPageAction,
  deleteNotebookPageAction,
  moveNotebookAction,
  moveNotebookPageAction,
  renameNotebookPageAction,
} from "@/app/(app)/notebook/actions";
import type { Subteam } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS, SUBTEAM_LABELS } from "@/lib/constants";
import { NOTEBOOK_DEFAULT_EMOJI } from "@/lib/notebook";
import { Button, ButtonLink } from "../ui/button";
import { Card } from "../ui/card";
import { FieldError, Input, Label } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";
import { ExportMenu } from "./export-menu";
import { MoveButtons } from "./move-buttons";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";
/** How long a confirmation ("Added “Intake”.") stays on screen. */
const MESSAGE_MS = 6000;
/** Notebooks this browser has folded up (a per-person convenience; everything works without it). */
const COLLAPSED_KEY = "hk-notebook-collapsed";

export interface NotebookSectionPage {
  id: string;
  title: string;
  entryCount: number;
  /** "Last entry 2 h ago", or null for an empty page (worked out on the server, so both sides render the same). */
  updatedLabel: string | null;
}

export interface NotebookSectionData {
  id: string;
  title: string;
  emoji: string;
  description: string;
  subteam: Subteam | null;
  entryCount: number;
  pages: NotebookSectionPage[];
  canManagePages: boolean;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

// Which notebooks are folded up, kept in localStorage (or, when the browser refuses storage, just for this visit).
const COLLAPSED_EVENT = "hk-notebook-collapsed-change";
let memoryCollapsed = "";

function readStored(): string {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) ?? "";
  } catch {
    return memoryCollapsed;
  }
}

function collapsedIds(stored: string): string[] {
  try {
    const ids: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeCollapsed(id: string, collapsed: boolean) {
  const ids = new Set(collapsedIds(readStored()));
  if (collapsed) ids.add(id);
  else ids.delete(id);
  const next = JSON.stringify([...ids].slice(-100));
  memoryCollapsed = next;
  try {
    window.localStorage.setItem(COLLAPSED_KEY, next);
  } catch {
    // Private windows can refuse storage; folding still works for this visit.
  }
  window.dispatchEvent(new Event(COLLAPSED_EVENT));
}

function subscribeCollapsed(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(COLLAPSED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(COLLAPSED_EVENT, onChange);
  };
}

/**
 * One notebook on the notebook home, like a heading in the team's Google Doc outline: its emoji and title (tap to
 * fold it up), then its pages. Everyone can open a page and export the notebook; managers also get the tools:
 * the captain and all-scope staff reorder and edit notebooks, and the notebook's subteam leaders (plus all-scope
 * staff) add, rename, reorder, and delete its pages. One status line announces what happened.
 * Just added or saved (`arrived`, after the notebook form): the status line says so, and focus (and the scroll) goes
 * to this notebook — its "New page" field when it was just added — not the top of the page.
 */
export function NotebookSection({
  notebook,
  canManageNotebooks,
  isFirst,
  isLast,
  arrived,
}: {
  notebook: NotebookSectionData;
  canManageNotebooks: boolean;
  isFirst: boolean;
  isLast: boolean;
  arrived?: "added" | "saved";
}) {
  const headingId = useId();
  const bodyId = useId();
  const statusId = useId();
  // Everything starts open on the server; this browser's folded-up notebooks apply right after.
  const stored = useSyncExternalStore(subscribeCollapsed, readStored, () => "");
  const open = !collapsedIds(stored).includes(notebook.id);
  const [message, setMessage] = useState(
    arrived === "added"
      ? notebook.canManagePages
        ? "Notebook added. Add its first page."
        : "Notebook added."
      : arrived === "saved"
        ? "Notebook saved."
        : "",
  );
  const listRef = useRef<HTMLOListElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusAfterDelete = useRef<{ id: string; index: number } | null>(null);
  const label = notebook.title;

  // Arriving from the notebook form: go to this notebook (the one just added is last, far down on a phone).
  useEffect(() => {
    if (!arrived) return;
    const target = arrived === "added" && addInputRef.current ? addInputRef.current : toggleRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
  }, [arrived]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  // After a delete, focus the next page's link (or the add field when the last one went).
  useEffect(() => {
    const pending = focusAfterDelete.current;
    if (!pending || notebook.pages.some((p) => p.id === pending.id)) return;
    focusAfterDelete.current = null;
    const links = listRef.current?.querySelectorAll<HTMLAnchorElement>("[data-page-link]");
    (links?.[pending.index] ?? links?.[pending.index - 1] ?? addInputRef.current)?.focus();
  }, [notebook.pages]);

  function toggle() {
    writeCollapsed(notebook.id, open);
  }

  const meta = [
    notebook.subteam ? SUBTEAM_LABELS[notebook.subteam] : "Whole team",
    plural(notebook.pages.length, "page", "pages"),
    plural(notebook.entryCount, "entry", "entries"),
  ].join(" · ");

  return (
    <section id={`notebook-${notebook.id}`} aria-labelledby={headingId} className="scroll-mt-24">
      <Card>
        <h2 id={headingId} className="text-base">
          <button
            ref={toggleRef}
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-describedby={arrived ? statusId : undefined}
            aria-controls={bodyId}
            className="flex min-h-14 w-full items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-ink-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 sm:px-5"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-xl" aria-hidden>
              {notebook.emoji || NOTEBOOK_DEFAULT_EMOJI}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-ink-900 wrap-anywhere">{notebook.title}</span>
              <span className="block text-xs font-normal text-ink-500 wrap-anywhere">{meta}</span>
            </span>
            <ChevronDown className={cn("size-5 shrink-0 text-ink-500 transition-transform", open && "rotate-180")} aria-hidden />
          </button>
        </h2>

        <div id={bodyId} hidden={!open} className="border-t border-ink-100 px-4 pb-4 pt-3 sm:px-5">
          {notebook.description && <p className="mb-3 text-sm text-ink-600 wrap-anywhere">{notebook.description}</p>}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ExportMenu
              label={notebook.title}
              wordHref={`/notebook/n/${encodeURIComponent(notebook.id)}/export`}
              printHref={`/notebook/print/n/${encodeURIComponent(notebook.id)}`}
            />
            {canManageNotebooks && (
              <>
                <ButtonLink
                  href={`/notebook/n/${encodeURIComponent(notebook.id)}/edit`}
                  variant="ghost"
                  aria-label={`Edit ${label}`}
                >
                  <Pencil className="size-4" aria-hidden />
                  Edit
                </ButtonLink>
                <MoveButtons
                  action={moveNotebookAction}
                  fields={{ notebookId: notebook.id }}
                  name={label}
                  isFirst={isFirst}
                  isLast={isLast}
                  onMessage={setMessage}
                />
              </>
            )}
          </div>

          {notebook.pages.length === 0 ? (
            <p className="py-2 text-sm text-ink-500">
              No pages yet.{notebook.canManagePages ? " Add the first one below." : " A leader will add them soon."}
            </p>
          ) : (
            <ol ref={listRef} className="divide-y divide-ink-100 rounded-lg border border-ink-100" aria-label={`Pages in ${label}`}>
              {notebook.pages.map((page, i) => (
                <li key={page.id} className="px-2 py-1">
                  <PageRow
                    page={page}
                    canManage={notebook.canManagePages}
                    isFirst={i === 0}
                    isLast={i === notebook.pages.length - 1}
                    onMessage={setMessage}
                    onDeleted={(text) => {
                      focusAfterDelete.current = { id: page.id, index: i };
                      setMessage(text);
                    }}
                  />
                </li>
              ))}
            </ol>
          )}

          {notebook.canManagePages && (
            <AddPageForm
              notebookId={notebook.id}
              notebookTitle={label}
              inputRef={addInputRef}
              onAdded={setMessage}
              describedBy={arrived === "added" ? statusId : undefined}
            />
          )}
          {/* Always rendered so screen readers announce each change. */}
          <p id={statusId} role="status" className="mt-2 text-sm text-brand-700 wrap-anywhere empty:mt-0">
            {message}
          </p>
        </div>
      </Card>
    </section>
  );
}

function PageRow({
  page,
  canManage,
  isFirst,
  isLast,
  onMessage,
  onDeleted,
}: {
  page: NotebookSectionPage;
  canManage: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMessage: (message: string) => void;
  onDeleted: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameRef = useRef<HTMLButtonElement>(null);

  const [deleteState, deleteAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await deleteNotebookPageAction(prev, formData);
    } catch {
      result = { ok: false, message: OFFLINE_MESSAGE, nonce: Date.now() };
    }
    if (result?.ok) onDeleted(`Deleted “${page.title}”.`);
    return result;
  }, initialActionState);

  function closeRename(message?: string) {
    setRenaming(false);
    if (message) onMessage(message);
    requestAnimationFrame(() => renameRef.current?.focus());
  }

  if (renaming) return <RenamePageForm page={page} onDone={closeRename} />;

  const entries = plural(page.entryCount, "entry", "entries");
  const deleteError = deleteState && !deleteState.ok ? deleteState.message : undefined;

  return (
    <div>
      {/* On a phone the tools wrap under the page's name, so the name keeps the whole width. */}
      <div className="flex flex-wrap items-center gap-x-1">
        <Link
          href={`/notebook/p/${encodeURIComponent(page.id)}`}
          data-page-link=""
          className="flex min-h-11 min-w-0 flex-[1_1_11rem] items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          <FileText className="size-4 shrink-0 text-brand-600" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink-900 wrap-anywhere">{page.title}</span>
            <span className="block text-xs text-ink-500">{[entries, page.updatedLabel].filter(Boolean).join(" · ")}</span>
          </span>
        </Link>
        {canManage && (
          <div className="ml-auto flex shrink-0 items-center">
            <Button ref={renameRef} variant="ghost" size="icon" onClick={() => setRenaming(true)} aria-label={`Rename ${page.title}`}>
              <Pencil className="size-4" aria-hidden />
            </Button>
            <MoveButtons
              action={moveNotebookPageAction}
              fields={{ pageId: page.id }}
              name={page.title}
              isFirst={isFirst}
              isLast={isLast}
              onMessage={onMessage}
            />
            <form action={deleteAction} className="inline-flex">
              <input type="hidden" name="pageId" value={page.id} />
              <SubmitButton
                variant="ghost"
                size="icon"
                aria-label={`Delete ${page.title}`}
                confirm={
                  page.entryCount > 0
                    ? `Delete the “${page.title}” page? Its ${entries} (and their pictures) go too. This can't be undone.`
                    : `Delete the “${page.title}” page?`
                }
              >
                <Trash2 className="size-4 text-red-600" aria-hidden />
              </SubmitButton>
            </form>
          </div>
        )}
      </div>
      {deleteError && (
        <p role="alert" className="mt-1 px-2 text-xs text-red-600 wrap-anywhere">
          {deleteError}
        </p>
      )}
    </div>
  );
}

function RenamePageForm({ page, onDone }: { page: NotebookSectionPage; onDone: (message?: string) => void }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await renameNotebookPageAction(prev, formData);
    } catch {
      const value = formData.get("title");
      return { ok: false, message: OFFLINE_MESSAGE, values: { title: typeof value === "string" ? value : page.title }, nonce: Date.now() };
    }
    if (result?.ok) {
      const next = String(formData.get("title") ?? "").trim();
      onDone(next && next !== page.title ? `Renamed “${page.title}” to “${next}”.` : undefined);
    }
    return result;
  }, initialActionState);
  const error = state && !state.ok ? (state.fieldErrors?.title ?? state.message) : undefined;

  useEffect(() => {
    if (state && !state.ok) inputRef.current?.focus();
  }, [state]);

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    }
  }

  return (
    <form action={formAction} onKeyDown={onKeyDown} noValidate className="space-y-1.5 px-2 py-2" aria-label={`Rename ${page.title}`}>
      <input type="hidden" name="pageId" value={page.id} />
      <Label htmlFor={inputId} className="wrap-anywhere">
        New name for “{page.title}”
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          name="title"
          required
          maxLength={LIMITS.notebookPageTitleMax}
          defaultValue={state && !state.ok ? (state.values?.title ?? page.title) : page.title}
          autoComplete="off"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className="min-w-0 grow basis-48"
        />
        <div className="flex gap-2">
          <SubmitButton pendingText="Saving…">Save</SubmitButton>
          <Button variant="ghost" onClick={() => onDone()}>
            Cancel
          </Button>
        </div>
      </div>
      <FieldError id={`${inputId}-error`}>{error}</FieldError>
    </form>
  );
}

function AddPageForm({
  notebookId,
  notebookTitle,
  inputRef,
  onAdded,
  describedBy,
}: {
  notebookId: string;
  notebookTitle: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onAdded: (message: string) => void;
  /** Also read out when the field gets focus (e.g. "Notebook added. Add its first page."). */
  describedBy?: string;
}) {
  const inputId = useId();
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await createNotebookPageAction(prev, formData);
    } catch {
      const title = formData.get("title");
      return { ok: false, message: OFFLINE_MESSAGE, values: { title: typeof title === "string" ? title : "" }, nonce: Date.now() };
    }
    if (result?.ok) onAdded(`Added “${String(formData.get("title") ?? "").trim()}”.`);
    return result;
  }, initialActionState);
  const error = state && !state.ok ? (state.fieldErrors?.title ?? state.message) : undefined;

  // Back to the field after every result: to fix an error, or to type the next page's name.
  useEffect(() => {
    if (state) inputRef.current?.focus();
  }, [state, inputRef]);

  return (
    <form action={formAction} noValidate className="mt-3 space-y-1.5" aria-label={`Add a page to ${notebookTitle}`}>
      <input type="hidden" name="notebookId" value={notebookId} />
      <Label htmlFor={inputId}>New page</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          name="title"
          required
          maxLength={LIMITS.notebookPageTitleMax}
          defaultValue={state && !state.ok ? (state.values?.title ?? "") : ""}
          placeholder="e.g. Drivetrain"
          autoComplete="off"
          invalid={!!error}
          aria-describedby={[error ? `${inputId}-error` : "", describedBy ?? ""].filter(Boolean).join(" ") || undefined}
          className="min-w-40 flex-[1_1_10rem]"
        />
        <SubmitButton pendingText="Adding…" variant="secondary" className="shrink-0">
          <Plus className="size-4" aria-hidden />
          Add page
        </SubmitButton>
      </div>
      <FieldError id={`${inputId}-error`}>{error}</FieldError>
    </form>
  );
}
