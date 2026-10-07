"use client";

import { unstable_rethrow } from "next/navigation";
import { createContext, type ReactNode, useActionState, useCallback, useContext, useState } from "react";
import { deleteMeetingAudioAction } from "@/app/(app)/meetings/actions";
import type { ActionState } from "@/lib/action-state";
import { FocusAlert } from "../sponsors/focus-alert";
import { SubmitButton } from "../ui/submit-button";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

type RecordingNotice = { ok: boolean; text: string };

const NoticeContext = createContext<((notice: RecordingNotice) => void) | null>(null);

/**
 * Where "Delete recording now" says how it went: just above the recording, outside it. Once the recording is deleted
 * the page refreshes without the button (or the whole card), so neither the message nor focus could stay there. The
 * message takes focus when it appears (FocusAlert), so keyboard and screen-reader users hear what happened instead of
 * landing on <body>. Renders no element of its own around `children`.
 */
export function RecordingNotices({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<(RecordingNotice & { key: number }) | null>(null);
  // A new key for every message, so the same one twice takes focus again.
  const report = useCallback((next: RecordingNotice) => setNotice((prev) => ({ ...next, key: (prev?.key ?? 0) + 1 })), []);
  return (
    <NoticeContext.Provider value={report}>
      {notice && (
        <FocusAlert key={notice.key} tone={notice.ok ? "success" : "error"}>
          {notice.text}
        </FocusAlert>
      )}
      {children}
    </NoticeContext.Provider>
  );
}

/**
 * "Delete recording now" (or "Delete recording" for an unfinished upload): asks first (`confirm`), then
 * deleteMeetingAudioAction. How it went — done, already deleted, or no connection — shows in RecordingNotices around
 * the recording; without one, a failure shows under the button.
 */
export function DeleteRecordingButton({ recapId, confirm, children }: { recapId: string; confirm: string; children: ReactNode }) {
  const report = useContext(NoticeContext);
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    let result: ActionState;
    try {
      result = await deleteMeetingAudioAction(prev, formData);
    } catch (e) {
      unstable_rethrow(e);
      result = { ok: false, message: OFFLINE_MESSAGE, nonce: Date.now() };
    }
    // Said outside this form: the refresh that follows the action usually takes the form away.
    if (result?.message) report?.({ ok: result.ok, text: result.message });
    return result;
  }, null);

  return (
    <form action={formAction} className="inline-flex flex-col">
      <input type="hidden" name="recapId" value={recapId} />
      <SubmitButton variant="ghost" confirm={confirm} pendingText="Deleting…">
        {children}
      </SubmitButton>
      {!report && state && !state.ok && state.message && (
        <p role="alert" className="mt-1 max-w-64 text-xs text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}
