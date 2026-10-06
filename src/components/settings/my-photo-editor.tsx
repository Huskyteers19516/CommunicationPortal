"use client";

import { EyeOff, Globe, ImageUp, LoaderCircle, Minus, Plus, Trash2, UsersRound } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { removeMyPhotoAction, uploadMyPhotoAction } from "@/app/(app)/settings/actions";
import { loadPicture, toJpeg } from "@/components/posters/shrink-picture";
import { AvatarPhoto } from "@/components/ui/avatar-photo";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import {
  CENTERED_CROP,
  clampPhotoCrop,
  movePhotoCrop,
  type PhotoCrop,
  photoCropRect,
  USER_PHOTO_ACCEPT,
  USER_PHOTO_MAX_ZOOM,
  USER_PHOTO_QUALITY,
  USER_PHOTO_SIDE,
  USER_PHOTO_UNREADABLE_MESSAGE,
  userPhotoFits,
  userPhotoProblem,
} from "@/lib/user-photos";

/** The preview circle's size in CSS pixels (size-40). */
const PREVIEW = 160;
/** How far an arrow key moves the photo, in preview pixels. */
const NUDGE = 8;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Draws the cropped square of `img` onto `canvas` at `side` × `side` pixels (white behind transparent parts). */
function drawCrop(canvas: HTMLCanvasElement, img: HTMLImageElement, crop: PhotoCrop, side: number): boolean {
  canvas.width = side;
  canvas.height = side;
  const g = canvas.getContext("2d");
  if (!g) return false;
  const { sx, sy, side: s } = photoCropRect(img.naturalWidth, img.naturalHeight, crop);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, side, side);
  g.imageSmoothingQuality = "high";
  g.drawImage(img, sx, sy, s, s, 0, 0, side, side);
  return true;
}

/**
 * Where your saved photo shows right now, as Settings → My photo says it under the preview (the preview itself always
 * shows it, so it has to say when nobody else sees it): `website` — on the team website, off (your switch), held off
 * by someone who manages your account (or after a rename), or the team shows no photos at all.
 */
export interface MyPhotoVisibility {
  inPortal: boolean;
  website: "on" | "off" | "held" | "team-off";
}

const WEBSITE_LINES: Record<MyPhotoVisibility["website"], string> = {
  on: "On the team website (public).",
  off: "Not on the team website: your switch below is off.",
  held: "Not on the team website for now (see below).",
  "team-off": "Not on the team website: the team isn't showing members' photos there right now.",
};

/**
 * Settings → My photo: pick a picture (PNG, JPG, or WebP; HEIC gets the iPhone hint), see it as the round avatar it
 * becomes, drag it or zoom to frame your face (arrow keys and +/- work too), then Save — the browser sends a
 * USER_PHOTO_SIDE-pixel square JPG, never the original. Replace and Remove (asks first). Under a saved photo: where it
 * shows (`visibility`). A status line says what happened; a problem with the picture shows on the picker, anything else
 * (too many changes, storage full…) as an alert.
 */
export function MyPhotoEditor({ name, photoSrc, visibility }: { name: string; photoSrc: string | null; visibility: MyPhotoVisibility }) {
  const [upload, uploadAction, uploading] = useActionState(uploadMyPhotoAction, initialActionState);
  const [remove, removeAction, removing] = useActionState(removeMyPhotoAction, initialActionState);
  const [latest, setLatest] = useState<"upload" | "remove" | null>(null);
  /** The picture being framed, and the upload answer it came after (a newer successful upload means it was saved). */
  const [pick, setPick] = useState<{ img: HTMLImageElement; after: number | undefined } | null>(null);
  const [crop, setCrop] = useState<PhotoCrop>(CENTERED_CROP);
  const [pickError, setPickError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const zoomId = `${inputId}-zoom`;
  const busy = uploading || removing || preparing;

  // Saved: back to the saved photo (the page now shows the new one).
  const picked = pick && !(upload?.ok && upload.nonce !== pick.after) ? pick.img : null;
  const setPicked = (img: HTMLImageElement | null) => setPick(img ? { img, after: upload?.nonce } : null);
  // Saved or removed: the buttons used are gone, so focus goes to the picker (the status line says what happened).
  useEffect(() => {
    if (upload?.ok) inputRef.current?.focus();
  }, [upload]);
  useEffect(() => {
    if (remove?.ok) inputRef.current?.focus();
  }, [remove]);

  // The preview, drawn sharp on high-density screens.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !picked) return;
    drawCrop(canvas, picked, crop, Math.round(PREVIEW * Math.min(3, window.devicePixelRatio || 1)));
  }, [picked, crop]);

  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = ""; // picking the same file again still works
    setLatest(null);
    if (!file) return;
    const problem = userPhotoProblem(file);
    setPickError(problem);
    if (problem) return;
    try {
      const img = await loadPicture(file);
      if (!img.naturalWidth || !img.naturalHeight) throw new Error("empty picture");
      setPicked(img);
      setCrop(CENTERED_CROP);
      // Focus the Save button once it's there, so keyboard users can save (or Tab back to adjust).
      requestAnimationFrame(() => saveRef.current?.focus());
    } catch {
      setPickError(USER_PHOTO_UNREADABLE_MESSAGE);
    }
  }

  function zoomTo(zoom: number) {
    if (!picked) return;
    setCrop((c) => clampPhotoCrop(picked.naturalWidth, picked.naturalHeight, { ...c, zoom }));
  }

  function moveBy(dx: number, dy: number) {
    if (!picked) return;
    setCrop((c) => movePhotoCrop(picked.naturalWidth, picked.naturalHeight, c, dx, dy, PREVIEW));
  }

  function onPointerDown(e: PointerEvent<HTMLCanvasElement>) {
    if (busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e: PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    moveBy(e.clientX - d.x, e.clientY - d.y);
    drag.current = { id: d.id, x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: PointerEvent<HTMLCanvasElement>) {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }

  function onKeyDown(e: KeyboardEvent<HTMLCanvasElement>) {
    // The arrow moves the photo that way (like dragging it).
    const moves: Record<string, [number, number]> = { ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE] };
    if (moves[e.key]) {
      e.preventDefault();
      moveBy(...moves[e.key]);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomTo(crop.zoom * 1.1);
    } else if (e.key === "-") {
      e.preventDefault();
      zoomTo(crop.zoom / 1.1);
    }
  }

  async function save() {
    if (!picked || busy) return;
    setPreparing(true);
    setLatest(null);
    try {
      const canvas = document.createElement("canvas");
      const blob = drawCrop(canvas, picked, crop, USER_PHOTO_SIDE) ? await toJpeg(canvas, USER_PHOTO_QUALITY) : null;
      if (!blob || !userPhotoFits(blob.size)) {
        setPickError(USER_PHOTO_UNREADABLE_MESSAGE);
        return;
      }
      setPickError(null);
      const form = new FormData();
      form.set("file", new File([blob], "photo.jpg", { type: "image/jpeg", lastModified: Date.now() }));
      setLatest("upload");
      startTransition(() => uploadAction(form));
    } finally {
      setPreparing(false);
    }
  }

  function removePhoto() {
    if (!photoSrc || busy) return;
    if (!window.confirm("Remove your photo? It comes off the portal and the team website. You can add one again any time.")) return;
    setLatest("remove");
    setPicked(null);
    startTransition(() => removeAction(new FormData()));
  }

  const result: ActionState = latest === "upload" ? upload : latest === "remove" ? remove : null;
  const success = result?.ok ? result.message : undefined;
  const failed = result && !result.ok ? result : null;
  // A problem with the picture goes on the picker; anything else (the hourly limit, storage full, …) isn't the file's.
  const fileError = pickError ?? (latest === "upload" ? failed?.fieldErrors?.file : undefined);
  const otherError = failed && !failed.fieldErrors?.file ? failed.message : undefined;

  return (
    <div className="space-y-3" aria-busy={busy}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {picked ? (
          <div className="space-y-2">
            <canvas
              ref={canvasRef}
              tabIndex={0}
              role="img"
              aria-label="Your new photo. Drag it, or use the arrow keys, to move it; + and − zoom."
              aria-describedby={hintId}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
              className="size-40 shrink-0 cursor-grab touch-none rounded-full border border-ink-200 bg-white shadow-sm active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            />
            <div className="flex w-full max-w-64 items-center gap-1">
              <Button type="button" variant="ghost" size="icon" onClick={() => zoomTo(crop.zoom / 1.25)} aria-label="Zoom out">
                <Minus className="size-4" aria-hidden />
              </Button>
              <label htmlFor={zoomId} className="sr-only">
                Zoom
              </label>
              <input
                id={zoomId}
                type="range"
                min={1}
                max={USER_PHOTO_MAX_ZOOM}
                step={0.01}
                value={crop.zoom}
                onChange={(e) => zoomTo(Number(e.currentTarget.value))}
                className="min-w-0 flex-1 accent-brand-600"
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => zoomTo(crop.zoom * 1.25)} aria-label="Zoom in">
                <Plus className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        ) : (
          <span
            aria-hidden
            className="relative inline-flex size-40 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-100 font-display text-4xl font-semibold text-brand-800"
          >
            {initials(name)}
            {photoSrc && <AvatarPhoto key={photoSrc} src={photoSrc} lazy={false} className="absolute inset-0 size-full object-cover" />}
          </span>
        )}

        <div className="min-w-0 flex-1 space-y-3">
          {picked ? (
            <>
              <p className="text-sm text-ink-700">
                This is how it looks on your name. Drag it or zoom to frame your face, then save.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button ref={saveRef} type="button" onClick={save} aria-disabled={busy || undefined}>
                  {uploading || preparing ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
                  {uploading || preparing ? "Saving…" : "Save photo"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (busy) return;
                    setPicked(null);
                    setPickError(null);
                    inputRef.current?.focus();
                  }}
                  aria-disabled={busy || undefined}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-700">
                {photoSrc ? "This is your photo." : "No photo yet: people see your initials."} A clear, friendly photo of
                your face works best.
              </p>
              {photoSrc && (
                <ul aria-label="Where your photo shows" className="space-y-1 text-sm">
                  <li className={cn("flex gap-1.5", visibility.inPortal ? "text-ink-600" : "font-medium text-amber-800")}>
                    {visibility.inPortal ? (
                      <UsersRound className="mt-0.5 size-4 shrink-0" aria-hidden />
                    ) : (
                      <EyeOff className="mt-0.5 size-4 shrink-0" aria-hidden />
                    )}
                    {visibility.inPortal
                      ? "In the portal: on your name."
                      : "Hidden in the portal: the team sees your initials instead."}
                  </li>
                  <li className={cn("flex gap-1.5", visibility.website === "on" ? "text-ink-600" : "font-medium text-amber-800")}>
                    {visibility.website === "on" ? (
                      <Globe className="mt-0.5 size-4 shrink-0" aria-hidden />
                    ) : (
                      <EyeOff className="mt-0.5 size-4 shrink-0" aria-hidden />
                    )}
                    {WEBSITE_LINES[visibility.website]}
                  </li>
                </ul>
              )}
            </>
          )}

          <div className="space-y-1.5">
            <label htmlFor={inputId} className="flex items-center gap-2 text-sm text-ink-700">
              <ImageUp className="size-4 shrink-0 text-ink-500" aria-hidden />
              {photoSrc || picked ? "Choose another picture" : "Choose a picture"}
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept={USER_PHOTO_ACCEPT}
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
              PNG, JPG, or WebP. It&apos;s made a {USER_PHOTO_SIDE} × {USER_PHOTO_SIDE} square on your device before it&apos;s
              sent, and hidden details such as where it was taken are removed.
            </p>
          </div>

          {photoSrc && !picked && (
            // aria-disabled rather than disabled while busy, so focus stays on it.
            <Button type="button" variant="secondary" onClick={removePhoto} aria-disabled={busy || undefined}>
              {removing ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
              Remove photo
            </Button>
          )}
        </div>
      </div>

      {/* Always rendered, so screen readers announce what changes in it. */}
      <div role="status" className="text-sm">
        {uploading ? (
          <p className="flex gap-1.5 text-ink-600">
            <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
            Saving your photo…
          </p>
        ) : (
          success && <p className="font-medium text-brand-700">{success}</p>
        )}
      </div>
      {otherError && (
        <p role="alert" className="text-sm text-red-600 wrap-anywhere">
          {otherError}
        </p>
      )}
    </div>
  );
}
