"use client";

import { ChevronDown, NotebookText, Pencil } from "lucide-react";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { updateSponsorshipInfoAction } from "@/app/(app)/sponsors/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { RichText } from "@/components/ui/rich-text";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";

/**
 * "Info for applications": the team address, contact person, and links people copy into sponsor forms
 * (the side box in the Business team's sheet). Anyone who can open Sponsorships can edit it.
 * Collapsed on phones until opened; always open from md up.
 */
export function SponsorshipInfoCard({ body, updatedLabel }: { body: string; updatedLabel: string | null }) {
  const [state, formAction] = useActionState(updateSponsorshipInfoAction, initialActionState);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [closedFor, setClosedFor] = useState<number | undefined>(undefined);
  const editRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusNext = useRef<"edit" | "textarea" | null>(null);
  const bodyId = useId();

  // A successful save closes the editor (together with the new text from the server)…
  if (state?.ok && state.nonce !== closedFor) {
    setClosedFor(state.nonce);
    setEditing(false);
  }
  // …and puts focus back on Edit, so keyboard users don't land on <body>. A failed save keeps the text
  // and focuses it.
  useEffect(() => {
    if (!state) return;
    (state.ok ? editRef : textareaRef).current?.focus();
  }, [state]);
  useEffect(() => {
    if (focusNext.current === "textarea") textareaRef.current?.focus();
    else if (focusNext.current === "edit") editRef.current?.focus();
    focusNext.current = null;
  }, [editing]);

  function startEditing() {
    focusNext.current = "textarea";
    setOpen(true);
    setEditing(true);
  }
  function cancel() {
    focusNext.current = "edit";
    setEditing(false);
  }

  const error = state && !state.ok ? state.fieldErrors?.body : undefined;
  const title = (
    <>
      <NotebookText className="size-4 shrink-0 text-brand-700" aria-hidden />
      Info for applications
    </>
  );

  return (
    <Card>
      <div
        className={cn(
          "flex items-center justify-between gap-3 border-ink-100 px-4 py-2 sm:px-5",
          open || editing ? "border-b" : "md:border-b",
        )}
      >
        <h2 className="min-w-0 flex-1 text-base font-semibold text-ink-900">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={bodyId}
            className="flex min-h-10 w-full items-center gap-2 text-left md:hidden"
          >
            {title}
            <ChevronDown className={cn("ml-auto size-4 shrink-0 text-ink-500 transition-transform", open && "rotate-180")} aria-hidden />
          </button>
          <span className="hidden min-h-10 items-center gap-2 md:flex">{title}</span>
        </h2>
        {!editing && (
          <Button ref={editRef} variant="secondary" onClick={startEditing} aria-label={body ? "Edit info for applications" : "Add info for applications"}>
            <Pencil className="size-4" aria-hidden />
            {body ? "Edit" : "Add"}
          </Button>
        )}
      </div>
      <div id={bodyId} className={cn("px-4 py-4 sm:px-5", open || editing ? "block" : "hidden", "md:block")}>
        {editing ? (
          <form action={formAction} className="space-y-4">
            <FormMessage state={state && !state.ok ? state : null} />
            <Field
              label="Info for applications"
              htmlFor="sponsorship-info-body"
              error={error}
              hint="Team address, contact person, links you need when filling out forms. Don't put passwords here — everyone who can open this page can read it."
            >
              <Textarea
                key={state?.nonce ?? 0}
                ref={textareaRef}
                id="sponsorship-info-body"
                name="body"
                rows={8}
                maxLength={LIMITS.teamNoteMax}
                invalid={!!error}
                aria-describedby={error ? "sponsorship-info-body-error" : undefined}
                defaultValue={state?.values?.body ?? body}
                placeholder={"Team address: …\nPerson of contact: …\nTeam email: …\nGrant links: https://…"}
              />
            </Field>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={cancel}>
                Cancel
              </Button>
              <SubmitButton pendingText="Saving…">Save</SubmitButton>
            </div>
          </form>
        ) : body ? (
          <div className="space-y-2">
            <RichText text={body} className="text-sm text-ink-800 wrap-anywhere" />
            {updatedLabel && <p className="text-xs text-ink-500">{updatedLabel}</p>}
          </div>
        ) : (
          <p className="text-sm text-ink-500">
            Nothing here yet. Add the team address, contact person, and links you need when filling out sponsor forms.
          </p>
        )}
        {!editing && state?.ok && (
          <p role="status" className="mt-2 text-xs font-medium text-brand-700">
            {state.message}
          </p>
        )}
      </div>
    </Card>
  );
}
