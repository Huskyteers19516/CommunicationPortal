"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { createContext, type ReactNode, useActionState, useContext, useId, useRef, useState, useSyncExternalStore } from "react";
import { deleteNotebookEntryAction } from "@/app/(app)/notebook/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { Button } from "../ui/button";
import { SubmitButton } from "../ui/submit-button";
import { draftSnapshot, subscribeDrafts } from "./entry-draft";
import { type EditorEntry, EntryEditor } from "./entry-editor";
import { useEntryRegion } from "./entry-region";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

interface EntryContextValue {
  entry: EditorEntry;
  canEdit: boolean;
  startEditing: () => void;
}

const EntryContext = createContext<EntryContextValue | null>(null);

/** Focus an entry's Edit button once it's back on the page (after the editor closes). */
function focusEditButton(entryId: string) {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>(`#entry-${CSS.escape(entryId)} [data-edit-entry]`)?.focus(),
  );
}

/**
 * One entry on a notebook page. Shows the server-rendered entry (`children`), or the editor in its place while
 * it's being changed. The Edit / Delete buttons inside the entry (EntryTools) find it through context.
 */
export function EditableEntry({
  entry,
  pageId,
  canEdit,
  timeZone,
  labelledBy,
  className,
  children,
}: {
  entry: EditorEntry;
  pageId: string;
  canEdit: boolean;
  timeZone: string;
  /** The id of the entry's heading. */
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const region = useEntryRegion();

  return (
    <article
      id={`entry-${entry.id}`}
      data-entry=""
      tabIndex={-1}
      aria-labelledby={labelledBy}
      className={cn(
        "min-w-0 scroll-mt-24 scroll-mb-40 rounded-xl border border-ink-200 bg-white shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 lg:scroll-mb-28",
        !editing && "p-4 sm:p-5",
        className,
      )}
    >
      {editing ? (
        <EntryEditor
          pageId={pageId}
          entry={entry}
          timeZone={timeZone}
          onClose={(result) => {
            setEditing(false);
            if (result) region.announce(result.message);
            focusEditButton(entry.id);
          }}
        />
      ) : (
        <EntryContext.Provider value={{ entry, canEdit, startEditing: () => setEditing(true) }}>{children}</EntryContext.Provider>
      )}
    </article>
  );
}

/** Edit and Delete for the entry around it (only for the person who wrote it and the notebook's leaders). */
export function EntryTools({ label }: { /** What the entry is called, for the buttons' labels. */ label: string }) {
  const ctx = useContext(EntryContext);
  const region = useEntryRegion();
  const [state, deleteAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await deleteNotebookEntryAction(prev, formData);
    } catch {
      result = { ok: false, message: OFFLINE_MESSAGE, nonce: Date.now() };
    }
    if (result?.ok && ctx) {
      region.announce("Entry deleted.");
      region.focusAfterRemoving(ctx.entry.id);
    }
    return result;
  }, initialActionState);
  if (!ctx?.canEdit) return null;

  const pictures = ctx.entry.images.length;
  const error = state && !state.ok ? state.message : undefined;
  return (
    <div className="flex shrink-0 flex-col items-end">
      <div className="-mr-2 -mt-2 flex items-center">
        <Button variant="ghost" data-edit-entry="" onClick={ctx.startEditing} aria-label={`Edit ${label}`} className="px-3">
          <Pencil className="size-4" aria-hidden />
          <span className="hidden sm:inline">Edit</span>
        </Button>
        <form action={deleteAction} className="inline-flex">
          <input type="hidden" name="entryId" value={ctx.entry.id} />
          <SubmitButton
            variant="ghost"
            size="icon"
            aria-label={`Delete ${label}`}
            confirm={`Delete this entry${pictures ? ` and its ${pictures === 1 ? "picture" : `${pictures} pictures`}` : ""}? Its history goes too. This can't be undone.`}
          >
            <Trash2 className="size-4 text-red-600" aria-hidden />
          </SubmitButton>
        </form>
      </div>
      {error && (
        <p role="alert" className="mt-1 max-w-48 text-right text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * "New entry": opens the editor at the top of the page's entries. Says so when this browser kept an unsaved draft
 * for the page (the editor picks it up). While it's open, the wrapper carries `data-composer-open` (the page hides
 * its "No entries yet" card).
 */
export function EntryComposer({ pageId, timeZone }: { pageId: string; timeZone: string }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const region = useEntryRegion();
  const hasDraft = useSyncExternalStore(subscribeDrafts, () => draftSnapshot(pageId) !== "", () => false);
  const draftNoteId = useId();

  return (
    <div data-composer-open={open ? "" : undefined}>
      {open ? (
        <EntryEditor
          pageId={pageId}
          timeZone={timeZone}
          onClose={(result) => {
            setOpen(false);
            if (result) {
              region.announce(result.message);
              region.focusEntry(result.entryId);
            } else {
              requestAnimationFrame(() => buttonRef.current?.focus());
            }
          }}
        />
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <Button
            ref={buttonRef}
            data-new-entry=""
            size="lg"
            onClick={() => setOpen(true)}
            className="w-full sm:w-auto"
            aria-describedby={hasDraft ? draftNoteId : undefined}
          >
            <Plus className="size-5" aria-hidden />
            New entry
          </Button>
          {hasDraft && (
            <p id={draftNoteId} className="text-sm text-ink-600">
              Your unsaved draft is kept. Tap New entry to finish it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
