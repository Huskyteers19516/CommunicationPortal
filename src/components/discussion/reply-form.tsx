"use client";

import { Send } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { createReplyAction } from "@/app/(app)/discussion/actions";
import { FieldError, Label, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";

/**
 * The reply box at the bottom of a discussion. A posted reply opens the page on it (the action redirects to
 * `?posted=<id>#reply-<id>`); the page gives this form a new key then, so it starts empty. After a failed send
 * the text stays and focus goes back to the box (or to the message).
 */
export function ReplyForm({ threadId }: { threadId: string }) {
  const [state, formAction] = useActionState(createReplyAction, initialActionState);
  const error = state?.fieldErrors?.body;
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state || state.ok) return;
    if (state.fieldErrors?.body) boxRef.current?.focus();
    else messageRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <input type="hidden" name="threadId" value={threadId} />
      {state && !state.ok && !error && (
        <div ref={messageRef} tabIndex={-1} className="rounded-lg focus:outline-none">
          <FormMessage state={state} />
        </div>
      )}
      <Label htmlFor="reply-body">Your reply</Label>
      <Textarea
        // Remounts with what was sent after an error (React clears a form after its action).
        key={state?.nonce ?? 0}
        ref={boxRef}
        id="reply-body"
        name="body"
        rows={4}
        required
        maxLength={LIMITS.discussionReplyMax}
        placeholder="Write a reply…"
        defaultValue={state && !state.ok ? (state.values?.body ?? "") : ""}
        invalid={!!error}
        aria-describedby={error ? "reply-body-error" : undefined}
      />
      <FieldError id="reply-body-error">{error}</FieldError>
      <div className="flex justify-end">
        <SubmitButton pendingText="Posting…" className="w-full sm:w-auto">
          <Send className="size-4" aria-hidden />
          Post reply
        </SubmitButton>
      </div>
    </form>
  );
}
