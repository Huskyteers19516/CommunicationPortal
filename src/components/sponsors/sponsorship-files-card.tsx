"use client";

import { CircleCheck, Download, ExternalLink, FileText, LoaderCircle, Trash2 } from "lucide-react";
import { type ChangeEvent, useActionState, useEffect, useId, useRef, useState } from "react";
import { deleteSponsorshipFileAction, uploadSponsorshipFileAction } from "@/app/(app)/sponsors/actions";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { FieldError, Label } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB, sponsorFileTooBigMessage } from "@/lib/files";

/** A file attached to the sponsor, as the card shows it. */
export interface SponsorFileView {
  id: string;
  filename: string;
  size: number;
  /** "Added by Ava Thompson · 2 d ago" */
  addedLabel: string;
  /** Opens it in a new tab (PDFs, images, text); null when it can only be downloaded. */
  viewHref: string | null;
  downloadHref: string;
  canDelete: boolean;
}

/** The team's file storage (Resources files, sponsor files, and posters together), in bytes. */
export interface FileStorageView {
  used: number;
  max: number;
}

/**
 * "Forms and files" on a sponsor's page: the sponsor's paper application form to print and fill out, the
 * filled-out copy… Picking a file uploads it right away (so it can't be forgotten when the edit form below is
 * saved), and Remove is its own small form: a status line says what happened, and focus goes to the new file,
 * or to the next one after a removal, so keyboard users keep their place. When an upload or removal fails, the
 * action re-renders the page too, so the list catches up with changes made elsewhere (e.g. another tab).
 */
export function SponsorshipFilesCard({
  sponsorshipId,
  files,
  storage,
}: {
  sponsorshipId: string;
  files: SponsorFileView[];
  storage: FileStorageView | null;
}) {
  const [upload, uploadAction, uploading] = useActionState(uploadSponsorshipFileAction, initialActionState);
  const [remove, removeAction] = useActionState(deleteSponsorshipFileAction, initialActionState);
  /**
   * Which form was used last (its result is the one shown) and the result it had before, which stays hidden
   * while the new one is on its way. Null once a new file is picked.
   */
  const [latest, setLatest] = useState<{ kind: "upload" | "remove"; staleNonce?: number } | null>(null);
  const [tooBig, setTooBig] = useState<string | null>(null);
  /** The name of the file on its way up (for the status line). */
  const [uploadingName, setUploadingName] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fullNoteRef = useRef<HTMLParagraphElement>(null);
  /** The files shown when the upload started (the new one is the one that isn't among them). */
  const beforeUpload = useRef<Set<string> | null>(null);
  /** The file being removed and where it was in the list (focus goes to the one after it). */
  const removing = useRef<{ id: string; index: number } | null>(null);
  const handled = useRef<{ upload?: number; remove?: number }>({});
  const headingId = useId();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  const full = files.length >= LIMITS.sponsorFilesMax;
  const wasFull = useRef(full);

  function focusFile(id: string) {
    listRef.current?.querySelector<HTMLElement>(`[data-file-name="${CSS.escape(id)}"]`)?.focus();
  }

  // Uploaded: focus the new file (once the refreshed list has it). Failed: back to the file input, whose error says why.
  useEffect(() => {
    if (!upload || upload.nonce === handled.current.upload) return;
    if (!upload.ok) {
      handled.current.upload = upload.nonce;
      inputRef.current?.focus();
      return;
    }
    const before = beforeUpload.current;
    const added = files.find((f) => !before?.has(f.id));
    if (!added) return; // the list hasn't refreshed yet; runs again when it does
    handled.current.upload = upload.nonce;
    focusFile(added.id);
  }, [upload, files]);

  // The file input went away while it had focus (an upload failed because the sponsor filled up elsewhere, and
  // the refreshed page shows it full): focus the note that says so, instead of losing focus to the page.
  useEffect(() => {
    const becameFull = full && !wasFull.current;
    wasFull.current = full;
    if (becameFull && document.activeElement === document.body) fullNoteRef.current?.focus();
  }, [full]);

  // Removed (or it was already gone, and the refreshed list no longer has it): focus the file that took its
  // place (or the one before it, or the file input when none are left). A removal that failed while the file is
  // still here keeps focus on its Remove button, next to the error.
  useEffect(() => {
    if (!remove || remove.nonce === handled.current.remove) return;
    const target = removing.current;
    if (target && files.some((f) => f.id === target.id)) return; // not refreshed yet (or it's still here)
    handled.current.remove = remove.nonce;
    const next = target ? (files[target.index] ?? files[target.index - 1]) : undefined;
    if (next) focusFile(next.id);
    else inputRef.current?.focus();
  }, [remove, files]);

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    const message = file && file.size > LIMITS.resourceFileMaxBytes ? sponsorFileTooBigMessage(file.size) : null;
    // A file that's too big isn't sent at all (the message says why).
    input.setCustomValidity(message ?? "");
    setTooBig(message);
    setLatest(null);
    // Upload right away: a picked file can't be left behind when someone saves the edit form below.
    if (file && !message) input.form?.requestSubmit();
  }

  const current = latest ? (latest.kind === "upload" ? upload : remove) : null;
  const result = current && current.nonce !== latest?.staleNonce ? current : null;
  const success = result?.ok ? result.message : undefined;
  const uploadError = latest?.kind === "upload" && result && !result.ok ? (result.fieldErrors?.file ?? result.message) : undefined;
  const fileError = tooBig ?? uploadError;
  const removeError = latest?.kind === "remove" && result && !result.ok ? result.message : undefined;
  const almostFull = storage !== null && storage.used >= storage.max * 0.9;

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader
          title={<span id={headingId}>Forms and files</span>}
          description="Attach an application form to print and fill out, or the filled-out copy."
        />
        {files.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-500 sm:px-5">No files yet.</p>
        ) : (
          <ul ref={listRef} className="divide-y divide-ink-100">
            {files.map((f, index) => (
              <li key={f.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <FileText className="mt-0.5 size-5 shrink-0 text-brand-700" aria-hidden />
                  <div className="min-w-0">
                    <p
                      data-file-name={f.id}
                      tabIndex={-1}
                      className="rounded font-medium text-ink-900 wrap-anywhere focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                    >
                      {f.filename}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500 wrap-anywhere">
                      {formatFileSize(f.size)} · {f.addedLabel}
                    </p>
                  </div>
                </div>
                {/* One row on phones too: Remove is just its icon there (40×40), so View, Download and Remove fit at 320px. */}
                <div data-file-actions className="flex flex-wrap items-start gap-2 sm:shrink-0 sm:justify-end">
                  {f.viewHref && (
                    <a href={f.viewHref} target="_blank" rel="noopener" className={buttonClasses("secondary", "md", "px-3")}>
                      <ExternalLink className="size-4" aria-hidden />
                      View
                      <span className="sr-only">
                        {" "}
                        {f.filename} (opens in a new tab)
                      </span>
                    </a>
                  )}
                  <a href={f.downloadHref} className={buttonClasses("secondary", "md", "px-3")}>
                    <Download className="size-4" aria-hidden />
                    Download
                    <span className="sr-only"> {f.filename}</span>
                  </a>
                  {f.canDelete && (
                    <form
                      action={removeAction}
                      onSubmit={() => {
                        removing.current = { id: f.id, index };
                        setLatest({ kind: "remove", staleNonce: remove?.nonce });
                      }}
                    >
                      <input type="hidden" name="fileId" value={f.id} />
                      {/* No pendingText: while removing, the spinner shows next to the icon, still inside 40×40 on phones. */}
                      <SubmitButton
                        variant="ghost"
                        size="icon"
                        className="sm:w-auto sm:gap-2 sm:px-3"
                        confirm={`Remove “${f.filename}” from this sponsor?`}
                        aria-label={`Remove ${f.filename}`}
                        title="Remove"
                      >
                        <Trash2 className="size-4" aria-hidden />
                        <span className="hidden sm:inline">Remove</span>
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Always rendered, so screen readers announce what changes in it. */}
        <div role="status" className="px-4 sm:px-5">
          {uploading ? (
            <p className="flex gap-1.5 pb-3 text-sm text-ink-600">
              <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
              <span className="min-w-0 wrap-anywhere">{uploadingName ? `Uploading “${uploadingName}”…` : "Uploading…"}</span>
            </p>
          ) : (
            success && (
              <p className="flex gap-1.5 pb-3 text-sm font-medium text-brand-700">
                <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 wrap-anywhere">{success}</span>
              </p>
            )
          )}
        </div>
        {removeError && (
          <p role="alert" className="px-4 pb-3 text-sm text-red-600 wrap-anywhere sm:px-5">
            {removeError}
          </p>
        )}

        <div className="border-t border-ink-100 px-4 py-4 sm:px-5">
          {full ? (
            <p
              ref={fullNoteRef}
              tabIndex={-1}
              className="rounded text-sm text-ink-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            >
              This sponsor has {LIMITS.sponsorFilesMax} files, the most it can have. Remove one to add another.
            </p>
          ) : (
            <form
              action={uploadAction}
              onSubmit={() => {
                beforeUpload.current = new Set(files.map((f) => f.id));
                setUploadingName(inputRef.current?.files?.[0]?.name ?? "");
                setLatest({ kind: "upload", staleNonce: upload?.nonce });
              }}
              aria-busy={uploading}
              className="space-y-1.5"
            >
              <input type="hidden" name="sponsorshipId" value={sponsorshipId} />
              <Label htmlFor={inputId}>Add a file</Label>
              <input
                ref={inputRef}
                id={inputId}
                name="file"
                type="file"
                required
                onChange={pickFile}
                onClick={(e) => {
                  // One upload at a time (it's aria-disabled rather than disabled, so focus stays here).
                  if (uploading) e.preventDefault();
                }}
                aria-disabled={uploading || undefined}
                aria-invalid={fileError ? true : undefined}
                aria-describedby={fileError ? `${errorId} ${hintId}` : hintId}
                className={cn(
                  "block w-full min-w-0 rounded-lg border bg-white p-1.5 text-sm text-ink-700 shadow-sm",
                  "file:mr-3 file:h-10 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-50 file:px-4 file:text-sm file:font-medium file:text-brand-800 hover:file:bg-brand-100",
                  uploading && "cursor-wait opacity-60",
                  fileError ? "border-red-400" : "border-ink-200",
                )}
              />
              {/* Right under the picker it's about. */}
              <FieldError id={errorId}>{fileError}</FieldError>
              <p id={hintId} className="text-xs text-ink-500">
                {`Uploads as soon as you pick it. A PDF, Word file, or photo of the form, up to ${RESOURCE_FILE_MAX_MB} MB (${LIMITS.sponsorFilesMax} files per sponsor).`}
              </p>
            </form>
          )}
          {storage && (
            <p className={cn("mt-3 text-xs", almostFull ? "font-medium text-amber-800" : "text-ink-500")}>
              {`${almostFull ? "Team file storage is almost full" : "Team file storage"}: ${formatFileSize(storage.used)} of ${formatFileSize(storage.max)} used (all the team's uploaded files together).`}
            </p>
          )}
        </div>
      </Card>
    </section>
  );
}
