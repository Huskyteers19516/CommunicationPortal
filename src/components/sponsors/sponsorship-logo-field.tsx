"use client";

import { ImageUp, LoaderCircle, Trash2, TriangleAlert } from "lucide-react";
import { type ChangeEvent, startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { removeSponsorshipLogoAction, uploadSponsorshipLogoAction } from "@/app/(app)/sponsors/actions";
import { Button } from "@/components/ui/button";
import { FieldError, Label } from "@/components/ui/field";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "@/lib/files";
import { SPONSOR_LOGO_ACCEPT, sponsorLogoProblem } from "@/lib/public-sponsors";

/** The sponsor's logo as the field shows it. */
export interface SponsorLogoView {
  id: string;
  /** The signed-in preview (/sponsors/logos/[id]). */
  previewHref: string;
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
  /** "Added by Amara Okafor · 2 d ago" */
  addedLabel: string;
}

/**
 * The brand logo in the sponsor's "Team website" section. It sits inside the edit form but saves on its own, right
 * away (its file input has no name, so the edit form never sends it): picking a picture uploads it (PNG, JPG, or WebP,
 * up to 4 MB — checked here first, and by its contents on the server), Remove asks first. A status line says what
 * happened and focus stays on the control that was used. A failed upload or removal re-renders the page too, so a
 * logo changed elsewhere shows up.
 */
export function SponsorshipLogoField({
  sponsorshipId,
  sponsorName,
  logo,
  logoNeeded,
  logoFromSameName = false,
}: {
  sponsorshipId: string;
  sponsorName: string;
  logo: SponsorLogoView | null;
  /** On the team website without a logo: say so. */
  logoNeeded: boolean;
  /** No logo here, but the website shows one from another sponsor with the same public name. */
  logoFromSameName?: boolean;
}) {
  const [upload, uploadAction, uploading] = useActionState(uploadSponsorshipLogoAction, initialActionState);
  const [remove, removeAction, removing] = useActionState(removeSponsorshipLogoAction, initialActionState);
  /** Which action ran last (its result is the one shown). */
  const [latest, setLatest] = useState<"upload" | "remove" | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const busy = uploading || removing;

  // A finished upload clears the picker (the new logo is shown above it), so picking the same file again uploads again.
  useEffect(() => {
    if (upload?.ok && inputRef.current) inputRef.current.value = "";
  }, [upload]);
  // Removed: its button is gone, so focus goes to the picker (the status line says what happened).
  useEffect(() => {
    if (remove?.ok) inputRef.current?.focus();
  }, [remove]);

  function send(kind: "upload" | "remove", form: FormData) {
    setLatest(kind);
    startTransition(() => (kind === "upload" ? uploadAction(form) : removeAction(form)));
  }

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    setLatest(null);
    if (!file) {
      setPickError(null);
      return;
    }
    const problem = sponsorLogoProblem(file);
    setPickError(problem);
    if (problem) return; // never sent
    const form = new FormData();
    form.set("sponsorshipId", sponsorshipId);
    form.set("file", file);
    send("upload", form);
  }

  function removeLogo() {
    if (!logo || busy) return;
    if (!window.confirm(`Remove ${sponsorName}'s logo? The team website then shows their name without one.`)) return;
    const form = new FormData();
    form.set("sponsorshipId", sponsorshipId);
    send("remove", form);
  }

  const result: ActionState = latest === "upload" ? upload : latest === "remove" ? remove : null;
  const success = result?.ok ? result.message : undefined;
  const uploadError = latest === "upload" && result && !result.ok ? (result.fieldErrors?.file ?? result.message) : undefined;
  const fileError = pickError ?? uploadError;
  const removeError = latest === "remove" && result && !result.ok ? result.message : undefined;
  const dimensions = logo?.width && logo.height ? `${logo.width} × ${logo.height} px · ` : "";

  return (
    <div className="space-y-3" aria-busy={busy}>
      <Label htmlFor={inputId}>{logo ? "Brand logo" : "Brand logo (optional)"}</Label>
      {logo ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* A checkerboard behind it, so a white or transparent logo still shows. */}
          <div
            className="flex h-24 w-full max-w-60 shrink-0 items-center justify-center rounded-lg border border-ink-200 p-2"
            style={{
              backgroundColor: "#fff",
              backgroundImage:
                "linear-gradient(45deg,#eef0f2 25%,transparent 25%),linear-gradient(-45deg,#eef0f2 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#eef0f2 75%),linear-gradient(-45deg,transparent 75%,#eef0f2 75%)",
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- an uploaded file served by our own route, any size */}
            <img src={logo.previewHref} alt={`${sponsorName} logo`} className="max-h-full max-w-full object-contain" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs text-ink-500 wrap-anywhere">
              <span className="font-medium text-ink-800">{logo.filename}</span>
              <br />
              {dimensions}
              {formatFileSize(logo.size)} · {logo.addedLabel}
            </p>
            {/* aria-disabled rather than disabled while busy, so focus stays on it. */}
            <Button type="button" variant="secondary" onClick={removeLogo} aria-disabled={busy || undefined}>
              {removing ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
              Remove logo
              <span className="sr-only"> of {sponsorName}</span>
            </Button>
          </div>
        </div>
      ) : logoNeeded ? (
        <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0">Logo needed: they&apos;re thanked on the team website, but only by name until their logo is added.</span>
        </p>
      ) : (
        logoFromSameName && (
          <p className="text-sm text-ink-600">
            The team website already shows a logo for this name (from the same sponsor in another year). Upload one here
            to replace it.
          </p>
        )
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <ImageUp className="size-4 shrink-0 text-ink-500" aria-hidden />
          <span className="text-sm text-ink-700">{logo ? "Replace it with another picture:" : "Upload their logo:"}</span>
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={SPONSOR_LOGO_ACCEPT}
          onChange={pickFile}
          onClick={(e) => {
            // One change at a time (aria-disabled rather than disabled, so focus stays here).
            if (busy) e.preventDefault();
          }}
          aria-disabled={busy || undefined}
          aria-invalid={fileError ? true : undefined}
          aria-describedby={fileError ? `${errorId} ${hintId}` : hintId}
          className={cn(
            "block w-full min-w-0 rounded-lg border bg-white p-1.5 text-sm text-ink-700 shadow-sm",
            "file:mr-3 file:h-10 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-50 file:px-4 file:text-sm file:font-medium file:text-brand-800 hover:file:bg-brand-100",
            busy && "cursor-wait opacity-60",
            fileError ? "border-red-400" : "border-ink-200",
          )}
        />
        <FieldError id={errorId}>{fileError}</FieldError>
        <p id={hintId} className="text-xs text-ink-500">
          {`Uploads as soon as you pick it. PNG, JPG, or WebP up to ${RESOURCE_FILE_MAX_MB} MB (no SVG). A wide logo on a transparent or white background looks best.`}
        </p>
      </div>

      {/* Always rendered, so screen readers announce what changes in it. */}
      <div role="status" className="text-sm">
        {uploading ? (
          <p className="flex gap-1.5 text-ink-600">
            <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
            Uploading the logo…
          </p>
        ) : (
          success && <p className="font-medium text-brand-700">{success}</p>
        )}
      </div>
      {removeError && (
        <p role="alert" className="text-sm text-red-600 wrap-anywhere">
          {removeError}
        </p>
      )}
    </div>
  );
}
