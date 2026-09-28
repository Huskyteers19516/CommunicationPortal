import { PencilLine } from "lucide-react";
import { editedByLine, formatStamp, formatStampDay, writtenByLine } from "@/lib/notebook";
import type { NotebookEntryView } from "@/server/queries/notebook";
import { EditableEntry, EntryTools } from "./editable-entry";
import { EntryHistory } from "./entry-history";
import { NotebookText } from "./notebook-text";

/**
 * One entry: its title (or the day it was written), the stamp "Written by Ethan Chen · Sun, Sep 27, 2026, 3:42 PM",
 * "Edited by …" when it was changed, the text, pictures, and "History (N)" — who changed it when, what each change
 * did, and what it said before (loaded when it's opened). Edit / Delete for its author and the notebook's leaders.
 */
export function EntryCard({ entry, pageId, timeZone }: { entry: NotebookEntryView; pageId: string; timeZone: string }) {
  const headingId = `entry-${entry.id}-title`;
  const heading = entry.title || formatStampDay(entry.createdAt, timeZone);
  const written = writtenByLine(entry.authorName, entry.createdAt, timeZone);
  return (
    <EditableEntry
      entry={{
        id: entry.id,
        title: entry.title,
        body: entry.body,
        images: entry.images.map((i) => ({ id: i.id, src: i.src, filename: i.filename })),
        writtenLine: written,
      }}
      pageId={pageId}
      canEdit={entry.canEdit}
      timeZone={timeZone}
      labelledBy={headingId}
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-base font-semibold leading-snug text-ink-900 wrap-anywhere">
            {heading}
          </h2>
          <p className="mt-1 text-xs text-ink-600 wrap-anywhere" data-stamp="">
            {written}
          </p>
          {entry.lastEditedAt && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-500 wrap-anywhere" data-edited="">
              <PencilLine className="size-3.5 shrink-0" aria-hidden />
              {editedByLine(entry.lastEditedByName, entry.lastEditedAt, timeZone)}
            </p>
          )}
        </div>
        <EntryTools label={entry.title ? `“${entry.title}”` : `the entry from ${formatStamp(entry.createdAt, timeZone)}`} />
      </header>

      <NotebookText body={entry.body} className="mt-3" />

      {entry.images.length > 0 && (
        <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Pictures">
          {entry.images.map((img, i) => (
            <li key={img.id} className="min-w-0">
              <a
                href={img.src}
                target="_blank"
                rel="noopener"
                className="block overflow-hidden rounded-lg border border-ink-200 bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                aria-label={`Open picture ${i + 1}, ${img.filename}, in a new tab`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; next/image can't fetch it */}
                <img
                  src={img.src}
                  alt=""
                  width={img.width ?? undefined}
                  height={img.height ?? undefined}
                  loading="lazy"
                  className="aspect-[4/3] h-auto w-full object-cover"
                />
              </a>
            </li>
          ))}
        </ul>
      )}

      {entry.historyCount > 0 && (
        <EntryHistory
          entryId={entry.id}
          historyCount={entry.historyCount}
          version={`${entry.historyCount}:${entry.lastEditedAt?.toISOString() ?? ""}`}
          timeZone={timeZone}
          written={written}
        />
      )}
    </EditableEntry>
  );
}
