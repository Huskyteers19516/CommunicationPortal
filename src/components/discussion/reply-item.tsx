"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { deleteReplyAction, updateReplyAction } from "@/app/(app)/discussion/actions";
import { ActionForm } from "@/components/tasks/action-form";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FieldError, Label, Textarea } from "@/components/ui/field";
import { RichText } from "@/components/ui/rich-text";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/constants";
import { NewRepliesDivider, useIsFirstNewReply } from "./read-state";

export interface ReplyItemData {
  id: string;
  body: string;
  /** The reply's updatedAt (ISO), sent back by the edit form. */
  version: string;
  /** "Maya Patel", or "A former member" for an account that was deleted. */
  authorName: string;
  /** "Software member", "Build Leader"… ("" when unknown). */
  position: string;
  /** Their portal photo (UserPhoto id) when they show one, else null (initials). */
  authorPhotoId: string | null;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** "2 h ago" and its full date and time (worked out on the server, so both renders agree). */
  when: string;
  whenTitle: string;
  createdAt: string;
  /** Full date and time of the last change, or null. */
  editedTitle: string | null;
}

/**
 * One reply: who wrote it (name + position), when, "edited", and the text. Its author edits it in place (Save /
 * Cancel; focus moves into the box and back, and a status line says what happened); its author and people with
 * admin access delete it. `justPosted`: it was just sent from this page, so it takes focus and says so.
 */
export function ReplyItem({ reply, justPosted = false }: { reply: ReplyItemData; justPosted?: boolean }) {
  const firstNew = useIsFirstNewReply(reply.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(reply.body);
  // What the last edit did ("Reply updated."); null = nothing yet (then a just-posted reply says so).
  const [status, setStatus] = useState<string | null>(null);
  // The save result showing when editing started (an old error isn't shown again).
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const itemRef = useRef<HTMLLIElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"item" | "box" | null>(null);
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await updateReplyAction(prev, formData);
    if (result?.ok) {
      setEditing(false);
      setStatus(result.message ?? "Reply updated.");
      focusNext.current = "item";
    } else {
      focusNext.current = "box";
    }
    return result;
  }, initialActionState);

  useEffect(() => {
    if (!justPosted) return;
    itemRef.current?.focus({ preventScroll: true });
    itemRef.current?.scrollIntoView({ block: "center" });
  }, [justPosted]);

  // After a save: back to the text (focused, with the status line) or, after an error, back into the box.
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "item") itemRef.current?.focus();
    else if (target === "box") boxRef.current?.focus();
  }, [state]);

  const shownStatus = editing ? "" : (status ?? (justPosted ? "Reply posted." : ""));
  const error =
    editing && state && !state.ok && state.nonce !== startedAt ? (state.fieldErrors?.body ?? state.message) : undefined;
  const boxId = `reply-edit-${reply.id}`;

  function startEditing() {
    setDraft(reply.body);
    setStatus("");
    setStartedAt(state?.nonce);
    setEditing(true);
    // After React shows the box.
    requestAnimationFrame(() => boxRef.current?.focus());
  }

  function cancel() {
    setEditing(false);
    requestAnimationFrame(() => editRef.current?.focus());
  }

  return (
    <li
      ref={itemRef}
      id={`reply-${reply.id}`}
      tabIndex={-1}
      className="min-w-0 scroll-mt-24 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
    >
      {firstNew && <NewRepliesDivider />}
      <article
        className={cn(
          "min-w-0 rounded-xl border bg-white p-4 shadow-sm",
          justPosted ? "border-brand-300 ring-1 ring-brand-200" : "border-ink-200",
        )}
      >
        <header className="flex min-w-0 items-start gap-3">
          <Avatar name={reply.authorName} size="sm" className="mt-0.5" photoId={reply.authorPhotoId} />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-sm font-semibold text-ink-900 wrap-anywhere">
              {reply.authorName}
              {reply.mine && <span className="font-normal text-ink-500"> (you)</span>}
            </p>
            <p className="mt-0.5 text-xs text-ink-500">
              {reply.position && <span className="wrap-anywhere">{reply.position} · </span>}
              <time className="whitespace-nowrap" dateTime={reply.createdAt} title={reply.whenTitle}>
                {reply.when}
              </time>
              {reply.editedTitle && (
                <span className="whitespace-nowrap" title={`Edited ${reply.editedTitle}`}>
                  {" "}
                  · edited
                </span>
              )}
            </p>
          </div>
        </header>

        {editing ? (
          <form action={formAction} className="mt-3 space-y-2" noValidate>
            <input type="hidden" name="replyId" value={reply.id} />
            <input type="hidden" name="version" value={reply.version} />
            <Label htmlFor={boxId} className="sr-only">
              Edit your reply
            </Label>
            <Textarea
              ref={boxRef}
              id={boxId}
              name="body"
              rows={4}
              required
              maxLength={LIMITS.discussionReplyMax}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !e.nativeEvent.isComposing) cancel();
              }}
              invalid={!!error}
              aria-describedby={error ? `${boxId}-error` : undefined}
            />
            <FieldError id={`${boxId}-error`}>{error}</FieldError>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={cancel}>
                Cancel
              </Button>
              <SubmitButton pendingText="Saving…">Save</SubmitButton>
            </div>
          </form>
        ) : (
          <RichText text={reply.body} className="mt-3 text-sm text-ink-800 wrap-anywhere sm:text-[0.9375rem]" />
        )}

        {/* Always there, so screen readers announce what appears in it. */}
        <p role="status" className={cn("text-xs font-medium text-brand-700", shownStatus && "mt-2")}>
          {shownStatus}
        </p>

        {!editing && (reply.canEdit || reply.canDelete) && (
          <div className="mt-2 flex flex-wrap items-start justify-end gap-1">
            {reply.canEdit && (
              <Button ref={editRef} variant="ghost" onClick={startEditing} aria-label="Edit your reply">
                <Pencil className="size-4" aria-hidden />
                Edit
              </Button>
            )}
            {reply.canDelete && (
              <ActionForm
                action={deleteReplyAction}
                fields={{ replyId: reply.id }}
                variant="ghost"
                confirm={reply.mine ? "Delete your reply? This can't be undone." : `Delete ${reply.authorName}'s reply? This can't be undone.`}
                pendingText="Deleting…"
                aria-label={reply.mine ? "Delete your reply" : `Delete ${reply.authorName}'s reply`}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete
              </ActionForm>
            )}
          </div>
        )}
      </article>
    </li>
  );
}
