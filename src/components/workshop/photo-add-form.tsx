"use client";

import { ImagePlus, LoaderCircle, Trash2 } from "lucide-react";
import { type ChangeEvent, useActionState, useEffect, useRef, useState } from "react";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "@/lib/files";
import {
  WORKSHOP_LIMITS,
  WORKSHOP_PHOTO_ACCEPT,
  WORKSHOP_PHOTO_MAX_SIDE,
  WORKSHOP_PHOTO_UNREADABLE_MESSAGE,
  workshopPhotoProblem,
  workshopPhotoTooBigMessage,
} from "@/lib/workshop";
import { useFocusFirstError } from "../auth/use-focus-first-error";
import type { FormAction } from "../tasks/types";
import { Button } from "../ui/button";
import { Field, FieldError, Input, Textarea } from "../ui/field";
import { FormMessage } from "../ui/form-message";
import { SubmitButton } from "../ui/submit-button";
import { preparePhoto } from "./shrink-photo";

interface Picked {
  file: File;
  /** A local preview (an object URL). */
  previewUrl: string;
  /** The picked photo's size before it was made web-sized (a JPG copy), if it was. */
  shrunkFrom?: number;
}

const NO_PHOTO = "Choose a photo to add.";

/**
 * Add a photo to a project (at the end of the story). The picked photo is checked right away, previewed, and made
 * web-sized in the browser (a JPG at most WORKSHOP_PHOTO_MAX_SIDE on the longest side) when it's bigger than that.
 * It's kept here, not in the file input, so it survives a save that comes back with an error (browsers clear file
 * inputs); one the server refuses is taken off, and why is said aloud. After it's added, the form is cleared for the
 * next version. A failed add puts focus on the first field to fix.
 */
export function WorkshopPhotoAddForm({
  projectId,
  photoCount,
  action,
}: {
  projectId: string;
  photoCount: number;
  action: FormAction;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  /** A picked photo is being checked and made smaller: adding waits for it. */
  const [preparing, setPreparing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  /** The result that was showing when a photo was picked: its file error no longer applies. */
  const [pickedAtNonce, setPickedAtNonce] = useState<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** Counts picks, so a photo that finishes shrinking after another one was picked is dropped. */
  const pickCount = useRef(0);

  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const sent = picked;
    if (!sent) {
      setAnnouncement(NO_PHOTO);
      return { ok: false, fieldErrors: { file: NO_PHOTO }, values: textValues(formData), nonce: Date.now() };
    }
    formData.set("file", sent.file);
    const result = await action(prev, formData);
    if (result?.ok) {
      setAnnouncement("");
      // Ready for the next version.
      setPicked((now) => (now === sent ? null : now));
      if (inputRef.current) inputRef.current.value = "";
    } else if (result?.fieldErrors?.file) {
      // The server refused the photo: take it off, so the picker shows why with nothing picked (and say why).
      setAnnouncement(result.fieldErrors.file);
      setPicked((now) => (now === sent ? null : now));
      if (inputRef.current) inputRef.current.value = "";
    }
    return result;
  }, initialActionState);
  useFocusFirstError(state, formRef);

  // Free the preview's memory when it's replaced or the form goes away.
  useEffect(() => {
    const url = picked?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [picked]);

  const serverError = state && !state.ok && state.nonce !== pickedAtNonce ? state.fieldErrors?.file : undefined;
  const error = preparing ? undefined : (pickError ?? serverError);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    setPickedAtNonce(state?.nonce);
    if (!file) return; // cancelled: keep what was there
    const run = ++pickCount.current;
    const reject = (problem: string) => {
      setPicked(null);
      setPickError(problem);
      setAnnouncement(problem);
      input.value = "";
    };
    const problem = workshopPhotoProblem(file);
    if (problem) {
      setPreparing(false);
      reject(problem);
      return;
    }
    setPreparing(true);
    setAnnouncement("Getting the photo ready…");
    const prepared = await preparePhoto(file);
    if (run !== pickCount.current) return; // another photo was picked meanwhile
    setPreparing(false);
    if (!prepared.ok) return reject(WORKSHOP_PHOTO_UNREADABLE_MESSAGE);
    if (prepared.file.size > LIMITS.resourceFileMaxBytes) return reject(workshopPhotoTooBigMessage(prepared.file.size));
    setPickError(null);
    setPicked({ file: prepared.file, previewUrl: URL.createObjectURL(prepared.file), shrunkFrom: prepared.shrunkFrom });
    setAnnouncement(
      prepared.shrunkFrom !== undefined
        ? `Picked “${prepared.file.name}”, made smaller to ${formatFileSize(prepared.file.size)} (it was ${formatFileSize(prepared.shrunkFrom)}).`
        : `Picked “${prepared.file.name}” (${formatFileSize(prepared.file.size)}).`,
    );
  }

  function clearPicked() {
    setPicked(null);
    setPickError(null);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
    setAnnouncement("Photo taken off.");
  }

  /** The preview can't show it (damaged): the website couldn't either. */
  function pickedIsBroken() {
    setPicked(null);
    setPickError(WORKSHOP_PHOTO_UNREADABLE_MESSAGE);
    setAnnouncement(WORKSHOP_PHOTO_UNREADABLE_MESSAGE);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-4" noValidate>
      {state && (state.ok || !state.fieldErrors) && <FormMessage state={state} />}
      <input type="hidden" name="projectId" value={projectId} />

      <div className="space-y-2">
        <p id="photo-file-label" className="text-sm font-medium text-ink-800">
          Photo
        </p>
        {picked && (
          <div className="flex flex-col gap-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3 sm:flex-row sm:items-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local preview (object URL) of the picked photo */}
            <img
              src={picked.previewUrl}
              alt="Preview of the picked photo"
              onError={pickedIsBroken}
              className="max-h-64 w-auto max-w-full self-start rounded-md object-contain sm:h-32 sm:max-w-48"
            />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-ink-900 wrap-anywhere">{picked.file.name}</p>
              <p className="text-ink-500">
                {[
                  formatFileSize(picked.file.size),
                  picked.shrunkFrom !== undefined && `made smaller from ${formatFileSize(picked.shrunkFrom)}`,
                  "uploads when you add it",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <Button variant="ghost" className="self-start sm:self-center" onClick={clearPicked} aria-label={`Take off ${picked.file.name}`}>
              <Trash2 className="size-4" aria-hidden />
              Take off
            </Button>
          </div>
        )}
        {/* The real input is visually hidden; the label is the big button. Keyboard focus shows on the label. */}
        <div>
          <input
            ref={inputRef}
            id="photo-file"
            type="file"
            accept={WORKSHOP_PHOTO_ACCEPT}
            onChange={pick}
            aria-labelledby="photo-file-label photo-file-choose"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "photo-file-error photo-file-hint" : "photo-file-hint"}
            className="peer sr-only"
          />
          <label
            id="photo-file-choose"
            htmlFor="photo-file"
            className={cn(
              "flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm font-medium transition-colors",
              "peer-focus:ring-2 peer-focus:ring-brand-500/40",
              error ? "border-red-400 text-red-700 hover:bg-red-50" : "border-brand-300 bg-brand-50/50 text-brand-800 hover:bg-brand-50",
            )}
          >
            <ImagePlus className="size-5 shrink-0" aria-hidden />
            {picked ? "Choose a different photo" : "Choose a photo"}
          </label>
        </div>
        {preparing && (
          <p className="flex items-center gap-2 text-sm text-ink-600">
            <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
            Getting the photo ready…
          </p>
        )}
        <FieldError id="photo-file-error">{error}</FieldError>
        <p id="photo-file-hint" className="text-xs text-ink-500">
          {`A PNG, JPG, or WebP photo or screenshot, up to ${RESOURCE_FILE_MAX_MB} MB. Big photos are made web-sized (${WORKSHOP_PHOTO_MAX_SIDE.toLocaleString("en-US")} pixels) for you.`}
        </p>
        {/* Always rendered, so screen readers announce what changes in it. */}
        <p role="status" className="sr-only">
          {announcement}
        </p>
      </div>

      <PhotoTextFields key={state?.nonce ?? 0} state={state} errors={errors} photoCount={photoCount} />

      <div className="flex justify-end">
        <SubmitButton pendingText="Uploading…" disabled={preparing} className="w-full sm:w-auto">
          <ImagePlus className="size-4" aria-hidden />
          Add photo
        </SubmitButton>
      </div>
    </form>
  );
}

function textValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["label", "note"]) {
    const v = formData.get(key);
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

function PhotoTextFields({ state, errors, photoCount }: { state: ActionState; errors: Record<string, string>; photoCount: number }) {
  const values = state && !state.ok ? state.values : undefined;
  return (
    <div className="space-y-4">
      <Field label="Label" htmlFor="photo-label" error={errors.label} optional>
        <Input
          id="photo-label"
          name="label"
          maxLength={WORKSHOP_LIMITS.photoLabelMax}
          defaultValue={values?.label ?? ""}
          invalid={!!errors.label}
          aria-describedby={errors.label ? "photo-label-error" : undefined}
          placeholder={`Version ${photoCount + 1}`}
          autoComplete="off"
        />
      </Field>
      <Field label="Note" htmlFor="photo-note" error={errors.note} optional>
        <Textarea
          id="photo-note"
          name="note"
          rows={2}
          maxLength={WORKSHOP_LIMITS.photoNoteMax}
          defaultValue={values?.note ?? ""}
          invalid={!!errors.note}
          aria-describedby={errors.note ? "photo-note-error" : undefined}
          placeholder="What changed, or what failed and why"
        />
      </Field>
    </div>
  );
}
