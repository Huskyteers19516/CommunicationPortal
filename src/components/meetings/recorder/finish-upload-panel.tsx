"use client";

import { ArrowLeft, ArrowRight, LoaderCircle, NotebookPen, RotateCcw, Trash2 } from "lucide-react";
import { uploadProgressText } from "@/lib/meeting-recorder/recorder-ui";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Card, CardBody } from "../../ui/card";
import type { UploadProgress } from "./engine/upload";
import { DownloadBar } from "./recorder-setup";

/** Finishing a recording's interrupted upload (from the copy this browser kept). */
export type FinishState =
  /** Asking the portal which parts it has. */
  | { stage: "checking" }
  | { stage: "uploading"; progress: UploadProgress | null }
  /** It stopped again (`retry`: worth trying again, e.g. the network). The recap is still waiting for the rest. */
  | { stage: "failed"; message: string; retry: boolean }
  /** The recap was deleted: the copy can be saved again as a new one. */
  | { stage: "orphaned"; message: string }
  /**
   * Nothing left to upload (past its 3 days, or the recap has no recording): `message` says which. `kept`: the copy is
   * still on this computer (it goes only when discarded).
   */
  | { stage: "over"; message: string; kept: boolean }
  /** Discarding: the part on the portal is being deleted, then the copy here. */
  | { stage: "discarding" }
  | { stage: "done" };

/** What Discard asks first: when the recap still waits for the rest of the recording, what reached the portal goes too. */
function discardQuestion(stage: FinishState["stage"]): string {
  return stage === "failed"
    ? "Delete the copy on this computer? The part of the recording already on the portal is deleted too, so the recap stays without its recording. This can't be undone."
    : "Delete the copy on this computer? This can't be undone.";
}

/** "Finish uploading": progress, then what happened, with what can be done next. */
export function FinishUploadPanel({
  title,
  state,
  onRetry,
  onBack,
  onDiscard,
  onReviewAsNew,
  onOpenRecap,
}: {
  /** The recap's title. */
  title: string;
  state: FinishState;
  onRetry: () => void;
  onBack: () => void;
  onDiscard: () => void;
  onReviewAsNew: () => void;
  onOpenRecap: () => void;
}) {
  const pct = state.stage === "uploading" && state.progress?.bytesTotal ? (state.progress.bytesDone / state.progress.bytesTotal) * 100 : 0;
  return (
    <Card>
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-600">
          Recording of <span className="font-semibold text-ink-900 wrap-anywhere">“{title || "a recap"}”</span>
        </p>
        <div role="status" className="space-y-3 empty:hidden">
          {(state.stage === "checking" || state.stage === "uploading" || state.stage === "discarding" || state.stage === "done") && (
            <p className="flex items-center gap-2.5 text-sm font-medium text-ink-800">
              <LoaderCircle className="size-4 shrink-0 animate-spin text-brand-600" aria-hidden />
              {state.stage === "checking"
                ? "Checking which parts the portal has…"
                : state.stage === "discarding"
                  ? "Deleting the recording…"
                  : state.stage === "done"
                    ? "Uploaded. Opening the recap…"
                    : state.progress
                      ? uploadProgressText(state.progress)
                      : "Uploading the recording…"}
            </p>
          )}
          {state.stage === "uploading" && state.progress && <DownloadBar pct={pct} label="Uploading the recording" />}
          {state.stage === "failed" && (
            <Alert tone="warning" role={null}>
              {state.message}
            </Alert>
          )}
          {(state.stage === "orphaned" || state.stage === "over") && (
            <Alert tone="info" role={null}>
              {state.message}
            </Alert>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {state.stage === "failed" && state.retry && (
            <Button onClick={onRetry}>
              <RotateCcw className="size-4" aria-hidden />
              Try again
            </Button>
          )}
          {state.stage === "orphaned" && (
            <Button onClick={onReviewAsNew}>
              <NotebookPen className="size-4" aria-hidden />
              Review &amp; save as a new recap
            </Button>
          )}
          {state.stage === "over" && (
            <Button onClick={onOpenRecap}>
              Open the recap
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          )}
          {(state.stage === "failed" || state.stage === "orphaned" || state.stage === "over") && (
            <Button variant="secondary" onClick={onBack}>
              <ArrowLeft className="size-4" aria-hidden />
              Not now
            </Button>
          )}
          {(state.stage === "failed" || state.stage === "orphaned" || (state.stage === "over" && state.kept)) && (
            <Button
              variant="ghost"
              onClick={() => {
                if (window.confirm(discardQuestion(state.stage))) onDiscard();
              }}
            >
              <Trash2 className="size-4 text-red-600" aria-hidden />
              Discard
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
