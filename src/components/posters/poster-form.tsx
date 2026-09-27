"use client";

import { FileText, ImagePlus, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { type ChangeEvent, useActionState, useEffect, useRef, useState } from "react";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, FieldError, Input, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "@/lib/files";
import { canShrinkPosterFile, POSTER_FILE_ACCEPT, POSTER_UNREADABLE_MESSAGE, posterFileProblem } from "@/lib/posters";
import { shrinkPicture } from "./shrink-picture";

export interface PosterFormValues {
  id?: string;
  title: string;
  description: string;
  link: string;
  event: string;
  /** "YYYY-MM-DD" or "". */
  eventDate: string;
  /** Editing: the file it has now (kept unless a new one is picked or it's removed). */
  currentFile?: { filename: string; size: number; kind: "image" | "pdf" | "file"; viewHref: string } | null;
}

interface Picked {
  file: File;
  /** A local preview for pictures (an object URL), null for PDFs. */
  previewUrl: string | null;
  /** The picked picture's size before the form made it smaller to fit (a JPG copy), if it did. */
  shrunkFrom?: number;
}

/**
 * Add / edit a poster. Made for phones: pick a photo or PDF (checked right away for size and type, with a
 * preview of pictures; a photo over the limit is made smaller first), give it a title, save. The picked file is
 * kept here, not in the file input, so it survives a save that comes back with an error (browsers clear file
 * inputs), and a file that's too big is never sent. A file the server refuses is taken off, so it isn't sent
 * again. Text values survive errors too (the fields remount with what was sent), and focus goes to the first
 * field to fix. The server checks everything again (`noValidate`: no browser bubbles).
 */
export function PosterForm({
  action,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: PosterFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  /** A picked photo is being made smaller: saving waits for it. */
  const [shrinking, setShrinking] = useState(false);

  // The picked file is sent from here (a file that's too big, or not a picture or PDF, is never kept, so never sent).
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const sent = picked;
    if (sent) formData.set("file", sent.file);
    else formData.delete("file");
    const result = await action(prev, formData);
    // The server refused the file (not really a picture, too many pixels, no room left): take it off, so the
    // picker shows the error with nothing picked, and the next save (e.g. with a link instead) doesn't send it again.
    if (sent && result && !result.ok && result.fieldErrors?.file) setPicked((now) => (now === sent ? null : now));
    return result;
  }, initialActionState);

  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);

  return (
    <form ref={formRef} action={formAction} className="space-y-6" noValidate>
      <FormMessage state={state} />
      {initial.id && <input type="hidden" name="posterId" value={initial.id} />}
      {initial.id && removeFile && !picked && <input type="hidden" name="removeFile" value="on" />}
      <Card>
        <CardBody className="space-y-5">
          <PosterFilePicker
            state={state}
            currentFile={initial.currentFile ?? null}
            picked={picked}
            pickError={pickError}
            removeFile={removeFile}
            shrinking={shrinking}
            onShrinking={setShrinking}
            onPick={(next, problem) => {
              setPicked(next);
              setPickError(problem);
              if (next) setRemoveFile(false);
            }}
            onRemoveCurrent={setRemoveFile}
          />
          <PosterFields key={state?.nonce ?? 0} state={state} initial={initial} />
        </CardBody>
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText={picked ? "Uploading…" : "Saving…"} disabled={shrinking}>
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}

function PosterFilePicker({
  state,
  currentFile,
  picked,
  pickError,
  removeFile,
  shrinking,
  onShrinking,
  onPick,
  onRemoveCurrent,
}: {
  state: ActionState;
  currentFile: PosterFormValues["currentFile"] | null;
  picked: Picked | null;
  pickError: string | null;
  removeFile: boolean;
  shrinking: boolean;
  onShrinking: (shrinking: boolean) => void;
  onPick: (picked: Picked | null, problem: string | null) => void;
  onRemoveCurrent: (remove: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  /** The result that was showing when a file was picked: its file error no longer applies. */
  const [pickedAtNonce, setPickedAtNonce] = useState<number | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  /** Counts picks, so a photo that finishes shrinking after another file was picked is dropped. */
  const pickCount = useRef(0);

  // Free the preview's memory when it's replaced or the form goes away.
  useEffect(() => {
    const url = picked?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [picked]);

  const serverError = state && !state.ok && state.nonce !== pickedAtNonce ? state.fieldErrors?.file : undefined;
  // While a new photo is being made smaller, the last file's problem no longer applies.
  const error = shrinking ? undefined : (pickError ?? serverError);
  const showCurrent = !picked && !!currentFile && !removeFile;

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    setPickedAtNonce(state?.nonce);
    if (!file) return; // cancelled: keep what was there
    const run = ++pickCount.current;
    let chosen = file;
    let shrunkFrom: number | undefined;
    // A phone photo (or PNG export) over the limit: make a smaller JPG copy instead of refusing it.
    const shrink = file.size > LIMITS.resourceFileMaxBytes && canShrinkPosterFile(file);
    onShrinking(shrink);
    if (shrink) {
      setAnnouncement("Making the picture smaller…");
      const smaller = await shrinkPicture(file);
      if (run !== pickCount.current) return; // another file was picked meanwhile
      onShrinking(false);
      if (smaller) {
        chosen = smaller;
        shrunkFrom = file.size;
      }
    }
    const problem = posterFileProblem(chosen);
    if (problem) {
      onPick(null, problem);
      setAnnouncement(problem);
      input.value = "";
      return;
    }
    const isImage = chosen.type.startsWith("image/");
    onPick({ file: chosen, previewUrl: isImage ? URL.createObjectURL(chosen) : null, shrunkFrom }, null);
    setAnnouncement(
      shrunkFrom
        ? `Picked “${chosen.name}”, made smaller to ${formatFileSize(chosen.size)} (it was ${formatFileSize(shrunkFrom)}).`
        : `Picked “${chosen.name}” (${formatFileSize(chosen.size)}).`,
    );
  }

  /** The picked picture can't be shown (damaged, or not really a picture): the grid couldn't show it either. */
  function pickedIsBroken() {
    onPick(null, POSTER_UNREADABLE_MESSAGE);
    if (inputRef.current) inputRef.current.value = "";
    setAnnouncement(POSTER_UNREADABLE_MESSAGE);
  }

  function clearPicked() {
    onPick(null, null);
    if (inputRef.current) inputRef.current.value = "";
    setAnnouncement(currentFile && !removeFile ? "Keeping the current file." : "File taken off. Pick another, or add a link.");
    inputRef.current?.focus();
  }

  const chooseLabel = picked || showCurrent ? "Choose a different file" : "Choose a picture or PDF";

  return (
    <div className="space-y-2">
      <p id="file-label" className="text-sm font-medium text-ink-800">
        Poster picture or PDF
      </p>

      {picked ? (
        <PickedPreview picked={picked} onClear={clearPicked} onBroken={pickedIsBroken} />
      ) : showCurrent && currentFile ? (
        <div className="flex flex-col gap-3 rounded-lg border border-ink-200 bg-ink-50 p-3 sm:flex-row sm:items-center">
          {currentFile.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; next/image can't fetch it
            <img
              src={currentFile.viewHref}
              alt="The poster's current picture"
              // Capped in the row layout, so a wide banner leaves room for the name and the button.
              className="h-32 w-auto max-w-full self-start rounded-md object-contain sm:max-w-48"
            />
          ) : (
            <FileText className="size-8 shrink-0 text-brand-700" aria-hidden />
          )}
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-ink-900 wrap-anywhere">{currentFile.filename}</p>
            <p className="text-ink-500">Current file · {formatFileSize(currentFile.size)}</p>
          </div>
          <Button
            ref={removeRef}
            variant="ghost"
            className="self-start sm:self-center"
            onClick={() => {
              onRemoveCurrent(true);
              setAnnouncement("The current file will be removed when you save.");
              // The button goes away: keep keyboard focus on the undo.
              requestAnimationFrame(() => keepRef.current?.focus());
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            Remove file
          </Button>
        </div>
      ) : (
        currentFile &&
        removeFile && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="min-w-0 flex-1 wrap-anywhere">
              “{currentFile.filename}” will be removed when you save.
            </p>
            <Button
              ref={keepRef}
              variant="secondary"
              onClick={() => {
                onRemoveCurrent(false);
                setAnnouncement("Keeping the current file.");
                requestAnimationFrame(() => removeRef.current?.focus());
              }}
            >
              <RotateCcw className="size-4" aria-hidden />
              Keep it
            </Button>
          </div>
        )
      )}

      {/* The real input is visually hidden; the label is the big button. Keyboard focus shows on the label. */}
      <div>
        <input
          ref={inputRef}
          id="file"
          name="file"
          type="file"
          accept={POSTER_FILE_ACCEPT}
          onChange={pick}
          aria-labelledby="file-label file-choose"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "file-error file-hint" : "file-hint"}
          className="peer sr-only"
        />
        <label
          id="file-choose"
          htmlFor="file"
          className={cn(
            "flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm font-medium transition-colors",
            // The input itself is hidden, so show its focus (keyboard, or after a failed save) here.
            "peer-focus:ring-2 peer-focus:ring-brand-500/40",
            error ? "border-red-400 text-red-700 hover:bg-red-50" : "border-brand-300 bg-brand-50/50 text-brand-800 hover:bg-brand-50",
          )}
        >
          <ImagePlus className="size-5 shrink-0" aria-hidden />
          {chooseLabel}
        </label>
      </div>
      {shrinking && (
        <p className="flex items-center gap-2 text-sm text-ink-600">
          <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
          Making the picture smaller…
        </p>
      )}
      <FieldError id="file-error">{error}</FieldError>
      <p id="file-hint" className="text-xs text-ink-500">
        {`A photo, screenshot, or PDF, up to ${RESOURCE_FILE_MAX_MB} MB (bigger photos are made smaller for you). No file? Add a link to the design below.`}
      </p>
      {/* Always rendered, so screen readers announce what changes in it. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function PickedPreview({ picked, onClear, onBroken }: { picked: Picked; onClear: () => void; onBroken: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3 sm:flex-row sm:items-center">
      {picked.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local preview (object URL) of the picked file
        <img
          src={picked.previewUrl}
          alt="Preview of the picked poster"
          onError={onBroken}
          // Capped in the row layout, so a wide banner leaves room for the name and the button.
          className="max-h-64 w-auto max-w-full self-start rounded-md object-contain sm:h-32 sm:max-w-48"
        />
      ) : (
        <FileText className="size-8 shrink-0 text-brand-700" aria-hidden />
      )}
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-ink-900 wrap-anywhere">{picked.file.name}</p>
        <p className="text-ink-500">
          {[
            formatFileSize(picked.file.size),
            picked.shrunkFrom !== undefined && `made smaller from ${formatFileSize(picked.shrunkFrom)}`,
            "uploads when you save",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <Button variant="ghost" className="self-start sm:self-center" onClick={onClear} aria-label={`Take off ${picked.file.name}`}>
        <Trash2 className="size-4" aria-hidden />
        Take off
      </Button>
    </div>
  );
}

function PosterFields({ state, initial }: { state: ActionState; initial: PosterFormValues }) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: "title" | "description" | "link" | "event" | "eventDate") => v?.[key] ?? initial[key];
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);

  return (
    <div className="space-y-5">
      <Field label="Title" htmlFor="title" error={errors.title}>
        <Input
          id="title"
          name="title"
          required
          maxLength={LIMITS.posterTitleMax}
          defaultValue={value("title")}
          invalid={!!errors.title}
          aria-describedby={described("title")}
          placeholder="e.g. Library demo flyer"
          autoComplete="off"
        />
      </Field>

      <Field label="Design link" htmlFor="link" error={errors.link} optional hint="A Canva or Google Drive link, so others can edit or print it.">
        <Input
          id="link"
          name="link"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={LIMITS.resourceUrlMax}
          defaultValue={value("link")}
          invalid={!!errors.link}
          aria-describedby={described("link")}
          placeholder="https://"
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="What it's for" htmlFor="event" error={errors.event} optional>
          <Input
            id="event"
            name="event"
            maxLength={LIMITS.posterEventMax}
            defaultValue={value("event")}
            invalid={!!errors.event}
            aria-describedby={described("event")}
            placeholder="e.g. Library demo"
            autoComplete="off"
          />
        </Field>
        <Field label="Event date" htmlFor="eventDate" error={errors.eventDate} optional hint="After this day it moves to Past.">
          <Input
            id="eventDate"
            name="eventDate"
            type="date"
            defaultValue={value("eventDate")}
            invalid={!!errors.eventDate}
            aria-describedby={described("eventDate")}
            className="max-w-48"
          />
        </Field>
      </div>

      <Field label="Description" htmlFor="description" error={errors.description} optional>
        <Textarea
          id="description"
          name="description"
          rows={3}
          maxLength={LIMITS.posterDescriptionMax}
          defaultValue={value("description")}
          invalid={!!errors.description}
          aria-describedby={described("description")}
          placeholder="Where it goes up, print size, who it's for…"
        />
      </Field>
    </div>
  );
}
