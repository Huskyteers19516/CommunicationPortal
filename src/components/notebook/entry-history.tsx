"use client";

import { History, LoaderCircle } from "lucide-react";
import { type SyntheticEvent, useActionState, useEffect, useRef, useState } from "react";
import { clearNotebookVersionAction } from "@/app/(app)/notebook/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import {
  formatStamp,
  isClearedNotebookVersion,
  notebookChangeLabel,
  type NotebookHistoryJson,
  notebookHistoryHref,
  type NotebookVersionText,
} from "@/lib/notebook";
import { Button } from "../ui/button";
import { SubmitButton } from "../ui/submit-button";
import { useEntryRegion } from "./entry-region";
import { NotebookText } from "./notebook-text";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";
const LOAD_ERROR = "Couldn't load the history. Check your connection and try again.";
/** "Before" text longer than this starts folded to a few lines, with "Show all". */
const LONG_CHARS = 400;
const LONG_LINES = 6;

type Version = NotebookHistoryJson["versions"][number];

/**
 * "History (N)" under an entry: who changed it, when, and what each change did ("changed the text", "changed the
 * pictures"…), with what it said before. The versions load when it's opened (they can be long), and load again when
 * the entry changes while it's open. Whoever can change the entry can take an old version's text out.
 */
export function EntryHistory({
  entryId,
  historyCount,
  version,
  timeZone,
  written,
}: {
  entryId: string;
  historyCount: number;
  /** Changes whenever the entry does (reloads an open History). */
  version: string;
  timeZone: string;
  /** "Written by Ethan Chen · …" (the end of the list). */
  written: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<NotebookHistoryJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const focusAfterLoad = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch(notebookHistoryHref(entryId), { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "That entry no longer exists." : LOAD_ERROR);
        return (await res.json()) as NotebookHistoryJson;
      })
      .then((json) => {
        setData(json);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error && e.message === "That entry no longer exists." ? e.message : LOAD_ERROR);
      });
    return () => controller.abort();
  }, [open, entryId, version, reload]);

  // After taking a version out, focus stays on that version (its button is gone).
  useEffect(() => {
    const id = focusAfterLoad.current;
    if (!id || !data) return;
    focusAfterLoad.current = null;
    document.getElementById(`version-${id}`)?.focus();
  }, [data]);

  function onToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
  }

  return (
    <details className="group mt-4 rounded-lg border border-ink-100 bg-ink-50/60" onToggle={onToggle}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink-700 hover:bg-ink-100 [&::-webkit-details-marker]:hidden">
        <History className="size-4 shrink-0" aria-hidden />
        {`History (${historyCount})`}
      </summary>
      <div className="px-3 pb-3 pt-1">
        {error ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
            <Button variant="secondary" onClick={() => setReload((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : !data ? (
          <p role="status" className="flex min-h-10 items-center gap-2 text-sm text-ink-600">
            <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
            Loading the history…
          </p>
        ) : (
          <ol className="space-y-3">
            {data.versions.map((v, i) => {
              const newer = data.versions[i - 1];
              const after: NotebookVersionText = newer
                ? { title: newer.previousTitle, body: newer.previousBody }
                : { title: data.title, body: data.body };
              return (
                <VersionRow
                  key={v.id}
                  version={v}
                  after={after}
                  timeZone={timeZone}
                  canClear={data.canClear}
                  onCleared={() => {
                    focusAfterLoad.current = v.id;
                    setReload((n) => n + 1);
                  }}
                />
              );
            })}
            {data.historyCount > data.versions.length ? (
              <li className="text-xs text-ink-500">
                Showing the {data.versions.length} most recent changes of {data.historyCount}.
              </li>
            ) : (
              <li className="text-xs text-ink-500 wrap-anywhere">{written}</li>
            )}
          </ol>
        )}
      </div>
    </details>
  );
}

function VersionRow({
  version: v,
  after,
  timeZone,
  canClear,
  onCleared,
}: {
  version: Version;
  /** What the entry said right after this change. */
  after: NotebookVersionText;
  timeZone: string;
  canClear: boolean;
  onCleared: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const before = { title: v.previousTitle, body: v.previousBody };
  const cleared = isClearedNotebookVersion(before);
  const label = notebookChangeLabel(before, after);
  const picturesOnly = label === "changed the pictures";
  const long = v.previousBody.length > LONG_CHARS || v.previousBody.split("\n").length > LONG_LINES;
  const bodyId = `version-${v.id}-before`;

  return (
    <li id={`version-${v.id}`} tabIndex={-1} className="min-w-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40">
      <p className="text-xs text-ink-600 wrap-anywhere">
        <span className="font-semibold text-ink-800">{v.editorName ?? "A former member"}</span> {label} ·{" "}
        {formatStamp(new Date(v.editedAt), timeZone)}
      </p>
      {cleared ? (
        <p className="mt-1 rounded-md border border-dashed border-ink-200 bg-white p-2.5 text-xs text-ink-600">
          What it said before was taken out of the history.
        </p>
      ) : (
        !picturesOnly && (
          <div className="mt-1 rounded-md border border-ink-200 bg-white p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Before</p>
              {canClear && <ClearVersionButton versionId={v.id} onCleared={onCleared} />}
            </div>
            <div
              id={bodyId}
              className={cn("relative", long && !expanded && "max-h-36 overflow-hidden")}
            >
              {v.previousTitle && <p className="mt-0.5 text-sm font-semibold text-ink-800 wrap-anywhere">{v.previousTitle}</p>}
              <NotebookText body={v.previousBody} className="mt-1 text-ink-600" />
              {long && !expanded && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-white" aria-hidden />
              )}
            </div>
            {long && (
              <Button
                variant="ghost"
                className="mt-1 px-2 text-brand-700"
                aria-expanded={expanded}
                aria-controls={bodyId}
                onClick={() => setExpanded((x) => !x)}
              >
                {expanded ? "Show less" : "Show all"}
              </Button>
            )}
          </div>
        )
      )}
    </li>
  );
}

function ClearVersionButton({ versionId, onCleared }: { versionId: string; onCleared: () => void }) {
  const region = useEntryRegion();
  const [state, action] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await clearNotebookVersionAction(prev, formData);
    } catch {
      result = { ok: false, message: OFFLINE_MESSAGE, nonce: Date.now() };
    }
    if (result?.ok) {
      region.announce("Taken out of the history.");
      onCleared();
    }
    return result;
  }, initialActionState);
  const error = state && !state.ok ? state.message : undefined;
  return (
    <form action={action} className="flex flex-col items-end">
      <input type="hidden" name="editId" value={versionId} />
      <SubmitButton
        variant="ghost"
        className="-my-2 -mr-2 px-2 text-xs text-red-700"
        aria-label="Take out what it said before"
        confirm="Take what it said before out of the history? Everyone still sees who changed it and when. This can't be undone."
      >
        Take out
      </SubmitButton>
      {error && (
        <p role="alert" className="max-w-48 text-right text-xs text-red-600 wrap-anywhere">
          {error}
        </p>
      )}
    </form>
  );
}
