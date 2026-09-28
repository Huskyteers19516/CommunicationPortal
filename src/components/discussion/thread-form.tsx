"use client";

import { useActionState, useEffect, useRef } from "react";
import type { DiscussionCategory } from "@/generated/prisma/enums";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { DISCUSSION_CATEGORIES, DISCUSSION_CATEGORY_LABELS, LIMITS } from "@/lib/constants";

/** The fields that show their own error (under the field). */
const FIELDS = ["title", "category", "body"] as const;

export interface ThreadFormValues {
  /** Editing: the discussion and the version (updatedAt) the form loaded. */
  id?: string;
  version?: string;
  title: string;
  category: DiscussionCategory;
  body: string;
}

/**
 * Start / edit a discussion: title, category, and text. Typed values survive errors (the fields remount with what
 * was sent), focus goes to the first field to fix — or to the message when it isn't about one field (e.g. it was
 * changed in another tab) — and the server explains problems inline (`noValidate`). One field's error shows only
 * under that field (the message box would repeat it); with several, the box says to fix the highlighted fields.
 */
export function ThreadForm({
  action,
  initial,
  submitLabel,
  pendingText,
  cancelHref,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: ThreadFormValues;
  submitLabel: string;
  pendingText: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const failed = !!state && !state.ok;
  const fieldMessages = FIELDS.map((k) => state?.fieldErrors?.[k]).filter(Boolean);
  const showMessage = failed && !!state.message && !fieldMessages.includes(state.message);
  useFocusFirstError(state, formRef);
  useEffect(() => {
    if (state && !state.ok && !FIELDS.some((k) => state.fieldErrors?.[k])) messageRef.current?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-5" noValidate>
      {initial.id && <input type="hidden" name="threadId" value={initial.id} />}
      {initial.version && <input type="hidden" name="version" value={initial.version} />}
      <Card>
        <CardBody>
          <ThreadFields key={state?.nonce ?? 0} state={state} initial={initial} />
        </CardBody>
      </Card>
      {showMessage && (
        <div ref={messageRef} tabIndex={-1} className="rounded-lg focus:outline-none">
          <FormMessage state={state} />
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText={pendingText}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function ThreadFields({ state, initial }: { state: ActionState; initial: ThreadFormValues }) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: "title" | "category" | "body") => v?.[key] ?? initial[key];
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Field label="Title" htmlFor="title" error={errors.title}>
          <Input
            id="title"
            name="title"
            required
            maxLength={LIMITS.discussionTitleMax}
            defaultValue={value("title")}
            invalid={!!errors.title}
            aria-describedby={described("title")}
            placeholder="e.g. Which intake wheels should we try?"
            autoComplete="off"
          />
        </Field>
        <Field label="Category" htmlFor="category" error={errors.category}>
          <Select
            id="category"
            name="category"
            defaultValue={value("category")}
            invalid={!!errors.category}
            aria-describedby={described("category")}
          >
            {DISCUSSION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {DISCUSSION_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="What do you want to talk about?"
        htmlFor="body"
        error={errors.body}
        hint="Everyone on the team can read it and reply. Links become clickable."
      >
        <Textarea
          id="body"
          name="body"
          rows={8}
          required
          maxLength={LIMITS.discussionBodyMax}
          defaultValue={value("body")}
          invalid={!!errors.body}
          aria-describedby={described("body")}
          placeholder="Share an idea, ask the team, or start a conversation…"
        />
      </Field>
    </div>
  );
}
