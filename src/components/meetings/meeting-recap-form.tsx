"use client";

import { ExternalLink, LoaderCircle } from "lucide-react";
import { unstable_isUnrecognizedActionError, unstable_rethrow, useRouter } from "next/navigation";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createMeetingRecapAction, type MeetingRecapCreateState, updateMeetingRecapAction } from "@/app/(app)/meetings/actions";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { cn } from "@/lib/cn";
import type { DateOnly } from "@/lib/dates";
import { type MeetingCategoryOption, meetingRecapHref, type MeetingRecapFormValues, newMeetingRequestId } from "@/lib/meeting-recaps";
import { Alert } from "../ui/alert";
import { Button, ButtonLink } from "../ui/button";
import { Card, CardBody } from "../ui/card";
import { FormMessage } from "../ui/form-message";
import { MeetingRecapFields, type MeetingRecapFieldValues } from "./meeting-recap-fields";

/** The fields that show their own error (under the field). */
const FIELDS = ["title", "meetingDate", "categoryIds", "keyPoints", "transcript"] as const;

/** The save never reached the server (no connection). What was typed stays in the form. */
const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again — what you typed is still here.";
/** The save reached a newer portal than this page (an update went out meanwhile): saving again won't help until a reload. */
const PORTAL_UPDATED_MESSAGE =
  "The portal was updated since this page opened, so it can't save. Copy what you typed somewhere safe, reload the page, and paste it back.";

/** The form's fields from a recap's values. */
function fieldValues(v: MeetingRecapFormValues): MeetingRecapFieldValues {
  return { title: v.title, meetingDate: v.meetingDate, categoryIds: v.categoryIds, keyPoints: v.keyPoints, transcript: v.transcript };
}

/** What tools inside the form (the edit page's "Suggest key points", "Transcribe the recording again") read and change. */
export interface MeetingRecapDraft {
  /** The fields as they are now (what Save would send). */
  values: MeetingRecapFieldValues;
  /** Changes fields, e.g. `update({ keyPoints })` after the person confirmed replacing them. */
  update: (patch: Partial<MeetingRecapFieldValues>) => void;
}

const DraftContext = createContext<MeetingRecapDraft | null>(null);

/** The form's fields, for a component rendered inside MeetingRecapForm (its `keyPointsActions` / `transcriptActions`). Null elsewhere. */
export function useMeetingRecapDraft(): MeetingRecapDraft | null {
  return useContext(DraftContext);
}

/**
 * Write up a recap (no `initial.id`: createMeetingRecapAction, then its page with `?saved=new` — `?saved=first` when
 * an earlier try of this save had made it and it kept its own text, `textKept`) or edit one
 * (`initial.id` and `version`: updateMeetingRecapAction, which opens it with `?saved=1` / `?saved=0`). The fields are
 * MeetingRecapFields, held here; what was typed survives every error (sent without React's form reset, and nothing is
 * echoed back — a transcript can be 300,000 characters), also a save that never reaches the server (offline, or the
 * portal was updated meanwhile: said in the message instead of an error page). Focus goes to the first field to fix,
 * or to the message when it isn't about one field.
 *
 * Editing: the form sends the `version` it loaded, and keeps sending it. When the page learns of a newer one (someone
 * else saved: the action refreshes the page after "Someone else changed this recap…", and adding a category refreshes
 * it too), a warning offers "See their version", "Use their version" (their text replaces the form's, after a confirm)
 * and "Save mine anyway" (saves over that version). Until the person picks one, Save changes (or Enter) only takes
 * them to that warning: nothing someone else saved is replaced without being asked.
 *
 * `keyPointsActions` / `transcriptActions`: extra controls next to those fields; they reach the fields with
 * useMeetingRecapDraft().
 */
export function MeetingRecapForm({
  initial,
  categories,
  today,
  cancelHref,
  keyPointsActions,
  transcriptActions,
}: {
  initial: MeetingRecapFormValues;
  categories: MeetingCategoryOption[];
  /** The team's today (the date picker's range). */
  today: DateOnly;
  cancelHref: string;
  keyPointsActions?: ReactNode;
  transcriptActions?: ReactNode;
}) {
  const editing = !!initial.id;
  const [state, formAction, pending] = useActionState(
    async (prev: MeetingRecapCreateState, formData: FormData): Promise<MeetingRecapCreateState> => {
      try {
        return await (editing ? updateMeetingRecapAction(prev, formData) : createMeetingRecapAction(prev, formData));
      } catch (e) {
        // Next's own redirect (a saved edit opens the recap) goes on as usual.
        unstable_rethrow(e);
        // Offline, or this page's actions are gone after an update: say so, and keep the form as it is.
        return { ok: false, message: unstable_isUnrecognizedActionError(e) ? PORTAL_UPDATED_MESSAGE : OFFLINE_MESSAGE, nonce: Date.now() };
      }
    },
    null,
  );
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const newerRef = useRef<HTMLDivElement>(null);
  // A new recap's request id, made on the first Save and sent again by every later one from this form: a save whose
  // answer got lost (offline for a moment) and is pressed again opens the recap it made instead of making a second —
  // with what the form says now, unless that recap was edited meanwhile (`textKept`: its page says so then).
  const requestIdRef = useRef<string | null>(null);
  const [values, setValues] = useState<MeetingRecapFieldValues>(() => fieldValues(initial));
  const update = useCallback((patch: Partial<MeetingRecapFieldValues>) => setValues((v) => ({ ...v, ...patch })), []);
  const draft = useMemo<MeetingRecapDraft>(() => ({ values, update }), [values, update]);
  const [notice, setNotice] = useState<string | null>(null);

  // The version the form's text is based on: the one it loaded, until the person takes a newer one (takeTheirs,
  // saveMine). A refresh of the page never moves it; it only shows that there's a newer one (`newer`).
  const [version, setVersion] = useState(initial.version);
  const newer = editing && !!version && !!initial.version && initial.version !== version;

  const failed = !!state && !state.ok;
  const errors = failed ? (state.fieldErrors ?? {}) : {};
  const fieldMessages = FIELDS.map((k) => errors[k]).filter(Boolean);
  const showMessage = failed && !!state.message && !fieldMessages.includes(state.message);
  const createdId = !editing && state?.ok ? state.recapId : undefined;
  const savedAs = state?.ok && state.textKept ? "first" : "new";
  const busy = pending || !!createdId;

  useFocusFirstError(state, formRef);
  useEffect(() => {
    if (state && !state.ok && !FIELDS.some((k) => state.fieldErrors?.[k])) messageRef.current?.focus();
  }, [state]);

  // Saved: open it (the action doesn't redirect, so the recorder can upload the recording first).
  useEffect(() => {
    if (createdId) router.push(`${meetingRecapHref(createdId)}?saved=${savedAs}`);
  }, [createdId, savedAs, router]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    // Someone else's newer version first: the warning says what saving would do, and how to go on.
    if (newer) {
      newerRef.current?.focus();
      return;
    }
    const formData = new FormData(e.currentTarget);
    if (!editing) {
      requestIdRef.current ??= newMeetingRequestId();
      formData.set("requestId", requestIdRef.current);
    }
    setNotice(null);
    startTransition(() => formAction(formData));
  }

  /** "Save mine anyway": save over the newer version the page shows (a later one is refused again). */
  function saveMine() {
    const form = formRef.current;
    if (!form || busy || !initial.version) return;
    const formData = new FormData(form);
    formData.set("version", initial.version);
    setVersion(initial.version);
    setNotice(null);
    startTransition(() => formAction(formData));
  }

  /** "Use their version": the newer version's text replaces the form's (after a confirm), and it's the one saved over. */
  function takeTheirs() {
    if (busy || !window.confirm("Replace what's in the form with their version? Your changes here will be lost.")) return;
    setValues(fieldValues(initial));
    setVersion(initial.version);
    setNotice("Their version is in the form now. Saving changes it from there.");
    document.getElementById("recap-title")?.focus();
  }

  return (
    <DraftContext.Provider value={draft}>
      <form ref={formRef} onSubmit={onSubmit} className="space-y-5" noValidate>
        {initial.id && <input type="hidden" name="recapId" value={initial.id} />}
        {version && <input type="hidden" name="version" value={version} />}
        {/* The meeting's length comes from the recorder; the form keeps it as it is. */}
        <input type="hidden" name="durationSec" value={initial.durationSec ?? ""} />
        <Card>
          <CardBody>
            <MeetingRecapFields
              values={values}
              onChange={update}
              categories={categories}
              today={today}
              errors={errors}
              keyPointsActions={keyPointsActions}
              transcriptActions={transcriptActions}
            />
          </CardBody>
        </Card>
        {showMessage && (
          <div
            ref={messageRef}
            tabIndex={-1}
            className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            <FormMessage state={state} />
          </div>
        )}
        {newer && initial.id && (
          <div ref={newerRef} tabIndex={-1} className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40">
            <Alert tone="warning" title="Someone else saved this recap while you were editing">
              <p>Saving yours now would replace their changes. Look at their version first, start again from it, or save yours anyway.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <ButtonLink href={meetingRecapHref(initial.id)} target="_blank" rel="noopener noreferrer" variant="secondary">
                  See their version
                  <ExternalLink className="size-4" aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </ButtonLink>
                <Button variant="secondary" onClick={takeTheirs}>
                  Use their version
                </Button>
                <Button variant="secondary" onClick={saveMine} aria-busy={busy} className={cn(busy && "cursor-wait opacity-60")}>
                  Save mine anyway
                </Button>
              </div>
            </Alert>
          </div>
        )}
        {notice && <Alert tone="info">{notice}</Alert>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <ButtonLink href={cancelHref} variant="secondary">
            Cancel
          </ButtonLink>
          <Button type="submit" aria-disabled={busy || undefined} aria-busy={busy} className={cn(busy && "cursor-wait opacity-60")}>
            {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            {busy ? "Saving…" : editing ? "Save changes" : "Save recap"}
          </Button>
        </div>
      </form>
    </DraftContext.Provider>
  );
}
