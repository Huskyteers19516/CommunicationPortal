"use client";

// The editor for one spot: a text box (with the website's original and "Reset to original"), an address for a link,
// or a picture (what's shown now, upload a new one with its description, change the description). Saves go through
// the Server Actions in src/app/(app)/admin/website/actions.ts; the page then gets the new values and the editor
// frame shows them at once (website-editor.tsx sends a fresh "preview").
import { ImagePlus, LoaderCircle, RotateCcw } from "lucide-react";
import { type ChangeEvent, useActionState, useEffect, useRef, useState } from "react";
import {
  resetSiteContentAction,
  setSiteImageAltAction,
  setSiteLinkAction,
  setSiteTextAction,
  uploadSiteImageAction,
} from "@/app/(app)/admin/website/actions";
import { preparePhoto } from "@/components/workshop/shrink-photo";
import { Field, FieldError, Input, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/files";
import {
  SITE_ALT_MAX,
  SITE_IMAGE_ACCEPT,
  SITE_IMAGE_NEEDS_FILE,
  SITE_IMAGE_UNREADABLE_MESSAGE,
  SITE_LINK_MAX,
  SITE_TEXT_MAX,
  type SiteSlot,
  siteImageProblem,
} from "@/lib/public-site-content";
import type { SiteContentEntry } from "@/server/queries/site-content";
import { adminSiteImageUrl } from "./preview";

export function SlotEditor({
  slot,
  entry,
  siteUrl,
  pagePath,
}: {
  slot: SiteSlot;
  /** The saved value, or null while the website shows its own. */
  entry: SiteContentEntry | null;
  siteUrl: string;
  pagePath: string;
}) {
  return (
    <div className="space-y-4">
      {slot.kind === "image" ? (
        <ImageEditor slot={slot} entry={entry} siteUrl={siteUrl} pagePath={pagePath} />
      ) : (
        <ValueEditor slot={slot} entry={entry} />
      )}
      {entry && <ResetForm slotKey={slot.key} />}
    </div>
  );
}

/** Text or link: one box, saved as a whole. */
function ValueEditor({ slot, entry }: { slot: SiteSlot; entry: SiteContentEntry | null }) {
  const isLink = slot.kind === "link";
  const [state, formAction] = useActionState(isLink ? setSiteLinkAction : setSiteTextAction, initialActionState);
  const failed = !!state && !state.ok;
  const current = entry && entry.kind === slot.kind ? entry.value : slot.defaultValue;
  const value = failed ? (state.values?.value ?? current) : current;
  // A new box after each answer and whenever the saved value changes (a reset, an undo), so it shows what's saved.
  const boxKey = `${state?.nonce ?? 0}:${current}`;
  const id = `slot-${slot.key}`;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="key" value={slot.key} />
      {isLink ? (
        <Field
          label="Link address"
          htmlFor={id}
          error={state?.fieldErrors?.value}
          hint="https://…, mailto:someone@example.com, or a page on the team website like /events."
        >
          <Input key={boxKey} id={id} name="value" defaultValue={value} maxLength={SITE_LINK_MAX} inputMode="url" autoComplete="off" spellCheck={false} />
        </Field>
      ) : (
        <Field
          label="Text"
          htmlFor={id}
          error={state?.fieldErrors?.value}
          hint={slot.multiline ? "Plain text. Line breaks show on the website." : "Plain text."}
        >
          {slot.multiline || slot.defaultValue.length > 80 ? (
            <Textarea key={boxKey} id={id} name="value" defaultValue={value} maxLength={SITE_TEXT_MAX} rows={slot.multiline ? 6 : 3} />
          ) : (
            <Input key={boxKey} id={id} name="value" defaultValue={value} maxLength={SITE_TEXT_MAX} />
          )}
        </Field>
      )}
      <FormMessage state={state} />
      <SubmitButton pendingText="Saving…">Save</SubmitButton>
      {entry && <Original value={slot.defaultValue} link={isLink} />}
    </form>
  );
}

function Original({ value, link }: { value: string; link: boolean }) {
  return (
    <details className="rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-ink-700">Website&apos;s original</summary>
      <p className={cn("mt-1 whitespace-pre-line text-ink-600", link ? "break-all" : "wrap-anywhere")}>{value || "(empty)"}</p>
    </details>
  );
}

function ResetForm({ slotKey }: { slotKey: string }) {
  const [state, formAction] = useActionState(resetSiteContentAction, initialActionState);
  return (
    <form action={formAction} className="space-y-2 border-t border-ink-100 pt-3">
      <input type="hidden" name="key" value={slotKey} />
      <FormMessage state={state} />
      <SubmitButton variant="secondary" pendingText="Resetting…" confirm="Go back to the website's original here? You can undo it in Recent changes.">
        <RotateCcw className="size-4" aria-hidden />
        Reset to original
      </SubmitButton>
    </form>
  );
}

/** The website's own picture, as an absolute address (its "defaultValue" may be relative to the page). */
function defaultPictureUrl(value: string, siteUrl: string, pagePath: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, `${siteUrl}${pagePath}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

interface Picked {
  file: File;
  previewUrl: string;
  shrunkFrom?: number;
}

function ImageEditor({ slot, entry, siteUrl, pagePath }: { slot: SiteSlot; entry: SiteContentEntry | null; siteUrl: string; pagePath: string }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickCount = useRef(0);
  const image = entry?.kind === "image" ? entry.image : null;

  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const sent = picked;
    if (!sent) return { ok: false, message: SITE_IMAGE_NEEDS_FILE, fieldErrors: { file: SITE_IMAGE_NEEDS_FILE }, nonce: Date.now() };
    formData.set("file", sent.file);
    const result = await uploadSiteImageAction(prev, formData);
    if (result?.ok || result?.fieldErrors?.file) {
      setPicked((now) => (now === sent ? null : now));
      if (inputRef.current) inputRef.current.value = "";
    }
    return result;
  }, initialActionState);
  const [altState, altAction] = useActionState(setSiteImageAltAction, initialActionState);

  useEffect(() => {
    const url = picked?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [picked]);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const run = ++pickCount.current;
    const reject = (problem: string) => {
      setPicked(null);
      setPickError(problem);
      input.value = "";
    };
    setPreparing(true);
    const prepared = await preparePhoto(file);
    if (run !== pickCount.current) return;
    setPreparing(false);
    if (!prepared.ok) return reject(SITE_IMAGE_UNREADABLE_MESSAGE);
    const problem = siteImageProblem(prepared.file);
    if (problem) return reject(problem);
    setPickError(null);
    setPicked({ file: prepared.file, previewUrl: URL.createObjectURL(prepared.file), shrunkFrom: prepared.shrunkFrom });
  }

  const shownUrl = image ? adminSiteImageUrl(image.id) : defaultPictureUrl(slot.defaultValue, siteUrl, pagePath);
  const fileError = preparing ? undefined : (pickError ?? (state && !state.ok ? state.fieldErrors?.file : undefined));
  const altId = `alt-${slot.key}`;
  const newAltId = `new-alt-${slot.key}`;

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-sm font-medium text-ink-800">{image ? "Shown now" : "Shown now (the website's own)"}</p>
        {shownUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a picture from this portal or the team website
          <img
            src={shownUrl}
            alt={image?.alt || "The picture shown now"}
            className="max-h-56 w-auto max-w-full rounded-lg border border-ink-200 bg-ink-50 object-contain"
          />
        ) : (
          <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-ink-300 bg-ink-50 text-sm text-ink-500">
            No photo yet
          </div>
        )}
      </div>

      <form action={formAction} className="space-y-3" noValidate>
        <input type="hidden" name="key" value={slot.key} />
        <div className="space-y-2">
          <p id={`file-label-${slot.key}`} className="text-sm font-medium text-ink-800">
            {image || shownUrl ? "Replace the picture" : "Add a picture"}
          </p>
          {picked && (
            <div className="flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/40 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local preview (object URL) of the picked picture */}
              <img src={picked.previewUrl} alt="Preview of the picked picture" className="h-16 w-auto max-w-28 rounded object-contain" />
              <p className="min-w-0 text-xs text-ink-600">
                <span className="block font-medium text-ink-900 wrap-anywhere">{picked.file.name}</span>
                {formatFileSize(picked.file.size)}
                {picked.shrunkFrom !== undefined && ` · made smaller from ${formatFileSize(picked.shrunkFrom)}`}
              </p>
            </div>
          )}
          <input
            ref={inputRef}
            id={`file-${slot.key}`}
            type="file"
            accept={SITE_IMAGE_ACCEPT}
            onChange={pick}
            aria-labelledby={`file-label-${slot.key} file-choose-${slot.key}`}
            aria-invalid={fileError ? true : undefined}
            className="peer sr-only"
          />
          <label
            id={`file-choose-${slot.key}`}
            htmlFor={`file-${slot.key}`}
            className={cn(
              "flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed px-3 py-2 text-sm font-medium",
              "peer-focus:ring-2 peer-focus:ring-brand-500/40",
              fileError ? "border-red-400 text-red-700" : "border-brand-300 bg-brand-50/50 text-brand-800 hover:bg-brand-50",
            )}
          >
            <ImagePlus className="size-5 shrink-0" aria-hidden />
            {picked ? "Choose a different picture" : "Choose a picture"}
          </label>
          {preparing && (
            <p className="flex items-center gap-2 text-sm text-ink-600">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Getting the picture ready…
            </p>
          )}
          <FieldError>{fileError}</FieldError>
          <p className="text-xs text-ink-500">PNG, JPG, or WebP. Big photos are made web-sized for you; location and camera details are removed.</p>
        </div>
        <Field label="Description" htmlFor={newAltId} optional error={state && !state.ok ? state.fieldErrors?.alt : undefined} hint="What's in the picture, for people who can't see it.">
          <Input id={newAltId} name="alt" defaultValue={image?.alt ?? ""} maxLength={SITE_ALT_MAX} key={`new-${state?.nonce ?? 0}`} />
        </Field>
        {state && (state.ok || !state.fieldErrors?.file) && <FormMessage state={state} />}
        <SubmitButton pendingText="Uploading…" disabled={preparing}>
          Upload picture
        </SubmitButton>
      </form>

      {image && (
        <form action={altAction} className="space-y-3 border-t border-ink-100 pt-3">
          <input type="hidden" name="key" value={slot.key} />
          <Field label="Description of the picture shown" htmlFor={altId} error={altState && !altState.ok ? altState.fieldErrors?.alt : undefined}>
            <Input
              key={`${image.id}:${image.alt}:${altState?.nonce ?? 0}`}
              id={altId}
              name="alt"
              defaultValue={altState && !altState.ok ? (altState.values?.alt ?? image.alt) : image.alt}
              maxLength={SITE_ALT_MAX}
            />
          </Field>
          <FormMessage state={altState} />
          <SubmitButton variant="secondary" pendingText="Saving…">
            Save description
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
