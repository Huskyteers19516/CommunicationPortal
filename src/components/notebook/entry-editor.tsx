"use client";

import { Clock, ImagePlus, LoaderCircle, RotateCcw, X } from "lucide-react";
import { type ChangeEvent, useActionState, useEffect, useId, useRef, useState } from "react";
import {
  addNotebookImageAction,
  createNotebookEntryAction,
  type EntryActionState,
  removeNotebookImageAction,
  updateNotebookEntryAction,
} from "@/app/(app)/notebook/actions";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import {
  formatStamp,
  NOTEBOOK_PICTURE_ACCEPT,
  NOTEBOOK_PICTURE_UNREADABLE_MESSAGE,
  notebookPictureProblem,
  notebookPicturesFullMessage,
} from "@/lib/notebook";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Field, FieldError, Input, Textarea } from "../ui/field";
import { FormMessage } from "../ui/form-message";
import { SubmitButton } from "../ui/submit-button";
import { clearDraft, readDraft, writeDraft } from "./entry-draft";
import { preparePicture } from "./prepare-picture";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

/** An existing entry, for editing it. */
export interface EditorEntry {
  id: string;
  title: string;
  body: string;
  images: { id: string; src: string; filename: string }[];
  /** "Written by Ethan Chen · Sun, Sep 27, 2026, 3:42 PM". */
  writtenLine: string;
}

interface PickedPicture {
  key: number;
  file: File;
  previewUrl: string;
  /** Why the server refused it (it stays, so it can be tried again or taken off). */
  error?: string;
}

export interface EditorResult {
  entryId: string;
  message: string;
}

/**
 * Write a new entry, or change one. The stamp at the top shows "You" and the date and time the moment it opens
 * (it ticks along; the server stamps the real time when it's saved). Title is optional; the text keeps its line
 * breaks, links work, and "- " lines become a bulleted list. Pictures are made smaller in the browser, previewed,
 * and can be taken off before saving; they upload one at a time after the text is saved (each can be up to 4 MB).
 * If a picture fails, the entry is still saved and the editor stays open with that picture, to try again or take off.
 * Nothing typed is thrown away without asking: Escape and Cancel ask first when there are unsaved changes (Escape
 * while typing with an input method is ignored), leaving the page warns, and a new entry's unsaved title and text
 * are kept in this browser for the page (entry-draft.ts) until it's saved or discarded.
 */
export function EntryEditor({
  pageId,
  entry,
  timeZone,
  onClose,
}: {
  pageId: string;
  /** Editing this entry; none = a new entry. */
  entry?: EditorEntry;
  timeZone: string;
  /** Closed: with what was saved, or nothing when cancelled before anything was saved. */
  onClose: (result?: EditorResult) => void;
}) {
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  /** A new entry picks up this page's unsaved draft (see entry-draft.ts). */
  const [restored] = useState(() => (entry ? null : readDraft(pageId)));
  const [title, setTitle] = useState(entry?.title ?? restored?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? restored?.body ?? "");
  /** The title and text as last saved from this editor (then only later changes count as unsaved). */
  const [savedText, setSavedText] = useState<{ title: string; body: string } | null>(null);
  const [picked, setPicked] = useState<PickedPicture[]>([]);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [pickError, setPickError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(0);
  const [progress, setProgress] = useState("");
  const [announcement, setAnnouncement] = useState("");
  /** Set once a new entry's text is saved (then saving again only retries its pictures and changes). */
  const [savedId, setSavedId] = useState<string | null>(entry?.id ?? null);
  const [now, setNow] = useState(() => new Date());
  const nextKey = useRef(0);
  /** A new entry's text is kept as a draft until it's saved or discarded. */
  const keepDraft = useRef(!entry);
  const latestText = useRef({ title, body });
  /** The pictures as they are now (the save reads it after awaiting, when its own copy would be stale). */
  const pickedRef = useRef(picked);
  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);

  // The stamp ticks along while the editor is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // Start typing right away (new entries: the text; editing: the title).
  useEffect(() => {
    (entry ? titleRef : bodyRef).current?.focus();
  }, [entry]);

  // Free the previews' memory when the editor goes away.
  useEffect(() => () => pickedRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl)), []);

  // Keep a new entry's text as a draft (a moment after typing stops, and when the editor goes away).
  useEffect(() => {
    latestText.current = { title, body };
    if (!keepDraft.current) return;
    const timer = setTimeout(() => {
      if (keepDraft.current) writeDraft(pageId, { title, body });
    }, 400);
    return () => clearTimeout(timer);
  }, [title, body, pageId]);
  useEffect(
    () => () => {
      if (keepDraft.current) writeDraft(pageId, latestText.current);
    },
    [pageId],
  );

  const existing = entry?.images ?? [];
  const keptCount = existing.filter((i) => !removing.has(i.id)).length;
  const room = LIMITS.notebookImagesPerEntry - keptCount - picked.length;
  const base = savedText ?? { title: entry?.title ?? "", body: entry?.body ?? "" };
  const dirty =
    title.trim() !== base.title.trim() || body.trim() !== base.body.trim() || picked.length > 0 || removing.size > 0;

  // Leaving the page (reload, closing the tab) with unsaved changes: the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // older Safari only asks when this is set
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const [state, formAction, pending] = useActionState(async (_prev: ActionState, formData: FormData): Promise<ActionState> => {
    const values = { title, body };
    const fail = (message: string, fieldErrors?: Record<string, string>): ActionState => ({
      ok: false,
      message,
      fieldErrors,
      values,
      nonce: Date.now(),
    });
    let entryId = savedId;
    let created = false;
    try {
      // 1. The text.
      let result: EntryActionState;
      if (entryId) {
        formData.set("entryId", entryId);
        result = await updateNotebookEntryAction(null, formData);
      } else {
        formData.set("pageId", pageId);
        result = await createNotebookEntryAction(null, formData);
      }
      if (!result?.ok) return result;
      if (!entryId && result.entryId) {
        entryId = result.entryId;
        created = true;
        setSavedId(entryId);
      }
      if (!entryId) return fail("Something went wrong. Please try again.");
      setSavedText({ title: values.title.trim(), body: values.body.trim() });
      if (keepDraft.current) {
        keepDraft.current = false;
        clearDraft(pageId);
      }

      // 2. Pictures taken off.
      for (const imageId of removing) {
        const fd = new FormData();
        fd.set("imageId", imageId);
        const r = await removeNotebookImageAction(null, fd);
        if (!r?.ok && !/already taken off/.test(r?.message ?? "")) return fail(r?.message ?? OFFLINE_MESSAGE);
      }
      setRemoving(new Set());

      // 3. New pictures, one at a time.
      const toSend = pickedRef.current;
      let failed = 0;
      let firstError = "";
      for (const [i, pic] of toSend.entries()) {
        setProgress(`Adding picture ${i + 1} of ${toSend.length}…`);
        const fd = new FormData();
        fd.set("entryId", entryId);
        fd.set("file", pic.file);
        let r: ActionState;
        try {
          r = await addNotebookImageAction(null, fd);
        } catch {
          r = { ok: false, message: OFFLINE_MESSAGE };
        }
        if (r?.ok) {
          URL.revokeObjectURL(pic.previewUrl);
          setPicked((now) => now.filter((p) => p.key !== pic.key));
        } else {
          failed++;
          const message = r?.fieldErrors?.file ?? r?.message ?? OFFLINE_MESSAGE;
          firstError ||= message;
          setPicked((now) => now.map((p) => (p.key === pic.key ? { ...p, error: message } : p)));
        }
      }
      setProgress("");
      if (failed > 0) {
        const what = failed === 1 ? "1 picture couldn't be added" : `${failed} pictures couldn't be added`;
        return fail(`Your entry is saved, but ${what}: ${firstError} Save again to retry, or take ${failed === 1 ? "it" : "them"} off.`, {
          file: firstError,
        });
      }
      onClose({ entryId, message: created || !entry ? "Entry saved." : "Changes saved." });
      return { ok: true, message: "Saved.", nonce: Date.now() };
    } catch {
      setProgress("");
      return fail(OFFLINE_MESSAGE);
    }
  }, initialActionState);

  useFocusFirstError(state, formRef);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0) return;
    setPickError(null);
    const accepted = files.slice(0, Math.max(0, room));
    const problems: string[] = [];
    if (files.length > accepted.length) problems.push(notebookPicturesFullMessage());
    setPreparing((n) => n + accepted.length);
    setAnnouncement(accepted.length > 0 ? "Getting the pictures ready…" : "");
    const added: PickedPicture[] = [];
    for (const original of accepted) {
      const file = await preparePicture(original);
      setPreparing((n) => n - 1);
      const problem = notebookPictureProblem(file);
      if (problem) {
        problems.push(`${original.name}: ${problem}`);
        continue;
      }
      added.push({ key: nextKey.current++, file, previewUrl: URL.createObjectURL(file) });
    }
    if (added.length) setPicked((now) => [...now, ...added]);
    const message = problems.join(" ");
    setPickError(message || null);
    setAnnouncement(
      [added.length ? `${added.length === 1 ? "1 picture" : `${added.length} pictures`} ready to add.` : "", message].filter(Boolean).join(" "),
    );
  }

  function takeOff(pic: PickedPicture) {
    URL.revokeObjectURL(pic.previewUrl);
    setPicked((now) => now.filter((p) => p.key !== pic.key));
    setAnnouncement(`Took off ${pic.file.name}.`);
    requestAnimationFrame(() => fileRef.current?.focus());
  }

  /** A picked picture the browser can't show: it couldn't be shown in the entry either. */
  function broken(pic: PickedPicture) {
    URL.revokeObjectURL(pic.previewUrl);
    setPicked((now) => now.filter((p) => p.key !== pic.key));
    setPickError(`${pic.file.name}: ${NOTEBOOK_PICTURE_UNREADABLE_MESSAGE}`);
    setAnnouncement(`${pic.file.name}: ${NOTEBOOK_PICTURE_UNREADABLE_MESSAGE}`);
  }

  function toggleRemove(id: string, filename: string) {
    const remove = !removing.has(id);
    const next = new Set(removing);
    if (remove) next.add(id);
    else next.delete(id);
    setRemoving(next);
    setAnnouncement(remove ? `${filename} will be taken off when you save.` : `Keeping ${filename}.`);
  }

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const fileError = pickError ?? (state && !state.ok ? errors.file : undefined);
  const hasPictureErrors = picked.some((p) => p.error);
  const titleId = `${uid}-title`;
  const bodyId = `${uid}-body`;
  const fileId = `${uid}-file`;
  const busy = pending || preparing > 0;
  const saved = savedId !== null && !entry;

  /** Cancel, Done, or Escape: asks first when something would be lost. */
  function requestClose() {
    if (pending) return;
    if (dirty && !window.confirm(savedId ? "Discard your unsaved changes?" : "Discard this entry?")) return;
    if (keepDraft.current) {
      keepDraft.current = false;
      clearDraft(pageId);
    }
    onClose(savedId && !entry ? { entryId: savedId, message: "Entry saved." } : undefined);
  }

  return (
    <Card className={cn(entry ? "border-0 shadow-none" : "border-brand-300 ring-2 ring-brand-500/15")}>
      <form
        ref={formRef}
        action={formAction}
        noValidate
        className="space-y-4 p-4 sm:p-5"
        aria-label={entry ? "Edit entry" : "New entry"}
        onKeyDown={(e) => {
          // Escape while an input method is composing (Chinese, Japanese…) only cancels the composition.
          if (e.key !== "Escape" || pending || e.nativeEvent.isComposing) return;
          e.preventDefault();
          requestClose();
        }}
      >
        {/* The stamp: who is writing, and when (the server stamps the real time on save). */}
        <div className="space-y-0.5 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">
          {entry && <p className="text-xs text-brand-800 wrap-anywhere">{entry.writtenLine}</p>}
          <p className="flex flex-wrap items-center gap-x-1.5">
            <Clock className="size-4 shrink-0" aria-hidden />
            <span className="font-semibold">You</span>
            <span aria-hidden>·</span>
            <time dateTime={now.toISOString()}>{formatStamp(now, timeZone)}</time>
            {entry && <span className="text-brand-700">(editing)</span>}
          </p>
          {saved && <p className="text-xs text-brand-800">Saved. The date and time were stamped when you posted it.</p>}
          {restored && !saved && <p className="text-xs text-brand-800">Picked up your unsaved draft.</p>}
        </div>

        <FormMessage state={state && !state.ok ? state : null} />

        <Field label="Title" htmlFor={titleId} error={errors.title} optional>
          <Input
            ref={titleRef}
            id={titleId}
            name="title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            maxLength={LIMITS.notebookEntryTitleMax}
            invalid={!!errors.title}
            aria-describedby={errors.title ? `${titleId}-error` : undefined}
            placeholder="e.g. Tested the new roller compliance"
            autoComplete="off"
          />
        </Field>

        <Field
          label="What did you do?"
          htmlFor={bodyId}
          error={errors.body}
          hint={`What you built, tested, or decided, and why. Start a line with "- " for a bulleted list.`}
        >
          <Textarea
            ref={bodyRef}
            id={bodyId}
            name="body"
            required
            rows={8}
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            maxLength={LIMITS.notebookEntryBodyMax}
            invalid={!!errors.body}
            aria-describedby={errors.body ? `${bodyId}-error` : undefined}
            className="min-h-40"
          />
        </Field>

        <div className="space-y-2">
          <p id={`${fileId}-label`} className="text-sm font-medium text-ink-800">
            Pictures <span className="font-normal text-ink-500">(optional)</span>
          </p>
          {(existing.length > 0 || picked.length > 0) && (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Pictures on this entry">
              {existing.map((img) => {
                const off = removing.has(img.id);
                return (
                  <li key={img.id} className="min-w-0">
                    <div className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in */}
                      <img
                        src={img.src}
                        alt={img.filename}
                        className={cn("aspect-square w-full rounded-md border border-ink-200 object-cover", off && "opacity-30")}
                      />
                      <Button
                        variant="secondary"
                        size="icon"
                        className="absolute right-1 top-1"
                        onClick={() => toggleRemove(img.id, img.filename)}
                        aria-label={off ? `Keep ${img.filename}` : `Take off ${img.filename}`}
                      >
                        {off ? <RotateCcw className="size-4" aria-hidden /> : <X className="size-4" aria-hidden />}
                      </Button>
                    </div>
                    {off && <p className="mt-1 text-xs text-amber-800">Taken off when you save</p>}
                  </li>
                );
              })}
              {picked.map((pic) => (
                <li key={pic.key} className="min-w-0">
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local preview (object URL) of the picked picture */}
                    <img
                      src={pic.previewUrl}
                      alt={`Preview of ${pic.file.name}`}
                      onError={() => broken(pic)}
                      className={cn(
                        "aspect-square w-full rounded-md border object-cover",
                        pic.error ? "border-red-400" : "border-brand-300",
                      )}
                    />
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute right-1 top-1"
                      onClick={() => takeOff(pic)}
                      aria-label={`Take off ${pic.file.name}`}
                      disabled={pending}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </div>
                  <p className={cn("mt-1 text-xs wrap-anywhere", pic.error ? "text-red-600" : "text-ink-500")}>
                    {pic.error ?? "Added when you save"}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {/* The real input is visually hidden; the label is the big button. Keyboard focus shows on the label. */}
          <div>
            <input
              ref={fileRef}
              id={fileId}
              type="file"
              multiple
              accept={NOTEBOOK_PICTURE_ACCEPT}
              onChange={pick}
              disabled={room <= 0}
              aria-labelledby={`${fileId}-label ${fileId}-choose`}
              aria-invalid={fileError || hasPictureErrors ? true : undefined}
              aria-describedby={fileError ? `${fileId}-error ${fileId}-hint` : `${fileId}-hint`}
              className="peer sr-only"
            />
            <label
              id={`${fileId}-choose`}
              htmlFor={fileId}
              className={cn(
                "flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm font-medium transition-colors",
                "peer-focus:ring-2 peer-focus:ring-brand-500/40",
                room <= 0
                  ? "cursor-not-allowed border-ink-200 text-ink-400"
                  : fileError || hasPictureErrors
                    ? "cursor-pointer border-red-400 text-red-700 hover:bg-red-50"
                    : "cursor-pointer border-brand-300 bg-brand-50/50 text-brand-800 hover:bg-brand-50",
              )}
            >
              <ImagePlus className="size-5 shrink-0" aria-hidden />
              {room <= 0 ? "No room for more pictures" : "Add pictures"}
            </label>
          </div>
          {preparing > 0 && (
            <p className="flex items-center gap-2 text-sm text-ink-600">
              <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
              Getting the pictures ready…
            </p>
          )}
          <FieldError id={`${fileId}-error`}>{fileError}</FieldError>
          <p id={`${fileId}-hint`} className="text-xs text-ink-500">
            {`CAD screenshots, test photos… up to ${LIMITS.notebookImagesPerEntry} per entry. Photos are made smaller for you.`}
          </p>
          <p role="status" className="sr-only">
            {announcement}
          </p>
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button variant="secondary" disabled={pending} onClick={requestClose}>
            {saved ? "Done" : "Cancel"}
          </Button>
          <SubmitButton pendingText={progress || "Saving…"} disabled={busy && !pending}>
            {entry ? "Save changes" : saved ? "Save again" : "Save entry"}
          </SubmitButton>
        </div>
      </form>
    </Card>
  );
}
