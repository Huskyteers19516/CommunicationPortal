"use client";

import { CircleCheck, Pencil } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { saveLeagueTeamSummaryAction } from "@/app/(app)/strategy/teams/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FieldError, Textarea } from "@/components/ui/field";
import { RichText } from "@/components/ui/rich-text";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";

/**
 * "Their strategy at a glance" on a team's page: anyone can write it. It's saved with the version it was opened at,
 * so when someone else saved it meanwhile the save is refused, their version shows up next to the box (the page
 * refreshes), and saving again replaces it. After a save, focus goes back to the Edit button and a status line
 * says so.
 */
export function TeamSummary({
  teamId,
  teamLabel,
  summary,
  version,
  updatedLabel,
}: {
  teamId: string;
  /** "9040 · STEAMpunks Alpha" */
  teamLabel: string;
  summary: string;
  /** summaryUpdatedAt as ISO ("" = never written). */
  version: string;
  /** "Updated by Grace Liu · 3 h ago", or null (never written). */
  updatedLabel: string | null;
}) {
  const [editing, setEditing] = useState(false);
  /** The version the editor was opened at: a different one now means someone else saved meanwhile. */
  const [openedVersion, setOpenedVersion] = useState(version);
  /** The last result that no longer shows: "Saved." or a refused save, once the editor is opened again. */
  const [dismissedNonce, setDismissedNonce] = useState<number | undefined>(undefined);
  const editRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const result = await saveLeagueTeamSummaryAction(prev, formData);
    if (result?.ok) setEditing(false);
    return result;
  }, initialActionState);

  // Saved: back to the Edit button (the editor is gone). Refused: back to the text, next to the message.
  useEffect(() => {
    if (!state) return;
    if (state.ok) editRef.current?.focus();
    else textRef.current?.focus();
  }, [state]);

  function open() {
    setOpenedVersion(version);
    setDismissedNonce(state?.nonce);
    setEditing(true);
    requestAnimationFrame(() => textRef.current?.focus());
  }

  function cancel() {
    setEditing(false);
    requestAnimationFrame(() => editRef.current?.focus());
  }

  // A refused save only counts while its editor is open: Cancel → Edit starts again from the current summary
  // (with the newest version), never from the text that was refused or its stale warning.
  const failed = state && !state.ok && state.nonce !== dismissedNonce ? state : null;
  const saved = !!state?.ok && !editing && state.nonce !== dismissedNonce;
  const changedMeanwhile = editing && version !== openedVersion;
  const error = failed?.fieldErrors?.summary;

  return (
    <section aria-labelledby="team-summary-title">
      <Card>
        <CardHeader
          title={<span id="team-summary-title">Their strategy at a glance</span>}
          description={updatedLabel ?? undefined}
          actions={
            !editing && (
              <Button ref={editRef} variant="secondary" onClick={open}>
                <Pencil className="size-4" aria-hidden />
                {summary ? "Edit" : "Write it"}
                <span className="sr-only"> (summary for {teamLabel})</span>
              </Button>
            )
          }
        />
        <CardBody className="space-y-3">
          {editing ? (
            <form action={formAction} className="space-y-3" noValidate>
              <input type="hidden" name="teamId" value={teamId} />
              {/* The newest version this page has seen: after a refused save, saving again replaces it. */}
              <input type="hidden" name="version" value={version} />
              {failed && !error && failed.message && <Alert tone={changedMeanwhile ? "warning" : "error"}>{failed.message}</Alert>}
              {changedMeanwhile && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="mb-1 text-xs font-semibold text-amber-900 wrap-anywhere">
                    {updatedLabel ? updatedLabel.replace(/^Updated by /, "Saved meanwhile by ") : "Saved meanwhile"}
                  </p>
                  {summary ? (
                    <RichText text={summary} className="text-sm text-ink-800 wrap-anywhere" />
                  ) : (
                    <p className="text-sm text-ink-600">They cleared it.</p>
                  )}
                </div>
              )}
              <label htmlFor="team-summary" className="sr-only">
                {`Their strategy at a glance (${teamLabel})`}
              </label>
              <Textarea
                // Remounts with what was sent after a refused save, so the text is never lost.
                key={failed?.nonce ?? 0}
                ref={textRef}
                id="team-summary"
                name="summary"
                rows={8}
                maxLength={LIMITS.leagueTeamSummaryMax}
                defaultValue={failed?.values?.summary ?? summary}
                invalid={!!error}
                aria-describedby={error ? "team-summary-error team-summary-hint" : "team-summary-hint"}
                placeholder="What do they do in auto? What do they score in TeleOp? Endgame? Strong and weak spots, who drives…"
              />
              <FieldError id="team-summary-error">{error}</FieldError>
              <p id="team-summary-hint" className="text-xs text-ink-500">
                Short notes are fine. Links become clickable. Everyone on the team can edit this.
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={cancel}>
                  Cancel
                </Button>
                <SubmitButton pendingText="Saving…">Save summary</SubmitButton>
              </div>
            </form>
          ) : summary ? (
            <RichText text={summary} className="text-sm text-ink-800 wrap-anywhere sm:text-base" />
          ) : (
            <p className="text-sm text-ink-500">
              Nothing yet. What do they do in auto, TeleOp, and endgame? Write down what you&apos;ve seen.
            </p>
          )}
          {/* Always rendered, so screen readers announce what changes in it. */}
          <p role="status" className={saved ? "flex items-center gap-1.5 text-sm font-medium text-brand-700" : "sr-only"}>
            {saved ? (
              <>
                <CircleCheck className="size-4 shrink-0" aria-hidden />
                Saved.
              </>
            ) : null}
          </p>
        </CardBody>
      </Card>
    </section>
  );
}
