"use client";

import { CloudUpload, History, LoaderCircle, Trash2 } from "lucide-react";
import { recoveryTitle } from "@/lib/meeting-recorder/recorder-ui";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import type { RecordingDoc } from "./engine/recorder-db";

/**
 * Recordings this browser kept that aren't on the portal yet (recorder-db.ts): a recording that was never saved (a
 * closed or crashed tab: **Review & save**) and a recap whose recording didn't finish uploading (**Finish
 * uploading**); each can be discarded (an interrupted upload's part on the portal goes too, so its recap doesn't say
 * "still uploading" for 3 days). `note`: what happened to the last one discarded, when that needs saying.
 */
export function RecoveryList({
  docs,
  timeZone,
  busyId,
  note,
  onReview,
  onFinish,
  onDiscard,
}: {
  docs: RecordingDoc[];
  timeZone: string;
  /** The one being opened or discarded (its buttons wait). */
  busyId: string | null;
  note?: string | null;
  onReview: (doc: RecordingDoc) => void;
  onFinish: (doc: RecordingDoc) => void;
  onDiscard: (doc: RecordingDoc) => void;
}) {
  return (
    <>
      {/* Always here, so a note is announced even when the list just emptied. */}
      <div role="status" className="empty:hidden">
        {note && (
          <Alert tone="warning" role={null}>
            {note}
          </Alert>
        )}
      </div>
      {docs.length > 0 && <Copies docs={docs} timeZone={timeZone} busyId={busyId} onReview={onReview} onFinish={onFinish} onDiscard={onDiscard} />}
    </>
  );
}

function Copies({
  docs,
  timeZone,
  busyId,
  onReview,
  onFinish,
  onDiscard,
}: {
  docs: RecordingDoc[];
  timeZone: string;
  busyId: string | null;
  onReview: (doc: RecordingDoc) => void;
  onFinish: (doc: RecordingDoc) => void;
  onDiscard: (doc: RecordingDoc) => void;
}) {
  return (
    <section aria-labelledby="recorder-recovery" className="space-y-2">
      <h2 id="recorder-recovery" className="text-sm font-semibold text-ink-800">
        Not on the portal yet
      </h2>
      <ul className="space-y-2">
        {docs.map((doc) => {
          const uploading = doc.status === "uploading" && !!doc.recapId;
          const busy = busyId === doc.id;
          return (
            <li key={doc.id} className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="flex items-start gap-3">
                {uploading ? (
                  <CloudUpload className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
                ) : (
                  <History className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="text-sm text-amber-900">
                    <p className="font-semibold wrap-anywhere">{recoveryTitle(doc, timeZone)}</p>
                    <p>
                      {uploading
                        ? "The recap is saved; its recording is still on this computer."
                        : doc.audioPurged
                          ? "Kept on this computer. Its audio was deleted after 3 days; the text can still be saved."
                          : "Kept on this computer, not saved to the portal yet."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => (uploading ? onFinish(doc) : onReview(doc))} disabled={!!busyId} aria-busy={busy}>
                      {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                      {uploading ? "Finish uploading" : "Review & save"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!!busyId}
                      onClick={() => {
                        const question = uploading
                          ? "Delete the copy on this computer? Its recording didn't finish uploading, so what reached the portal is deleted too — the recap stays, without its recording. This can't be undone."
                          : "Discard this recording? It's deleted from this computer, and nothing is saved. This can't be undone.";
                        if (window.confirm(question)) onDiscard(doc);
                      }}
                    >
                      <Trash2 className="size-4 text-red-600" aria-hidden />
                      Discard
                    </Button>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
