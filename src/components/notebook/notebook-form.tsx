"use client";

import { useActionState, useRef, useState } from "react";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import type { Subteam } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS, SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { NOTEBOOK_DEFAULT_EMOJI, NOTEBOOK_DESCRIPTION_MAX, NOTEBOOK_EMOJI_MAX } from "@/lib/notebook";
import { ButtonLink } from "../ui/button";
import { Card, CardBody } from "../ui/card";
import { Field, Input, Select, Textarea } from "../ui/field";
import { FormMessage } from "../ui/form-message";
import { SubmitButton } from "../ui/submit-button";

export interface NotebookFormValues {
  id?: string;
  title: string;
  emoji: string;
  description: string;
  /** "" = whole team. */
  subteam: "" | Subteam;
}

/** Quick picks for the emoji (anything can be typed or pasted instead). */
const EMOJI_CHOICES = ["👷", "🧑‍💻", "🧑‍💼", "🔧", "🤖", "📐", "🏆", "📓"];

/**
 * Add / edit a notebook: its title, an emoji for the outline, whose notebook it is (that subteam's leaders manage
 * its pages), and a short description. Values survive a failed save and focus goes to the first field to fix.
 */
export function NotebookForm({
  action,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: NotebookFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);

  return (
    <form ref={formRef} action={formAction} className="space-y-6" noValidate>
      <FormMessage state={state} />
      {initial.id && <input type="hidden" name="notebookId" value={initial.id} />}
      <Card>
        {/* Remounts with what was sent after each result, so typed values survive an error. */}
        <NotebookFields key={state?.nonce ?? 0} state={state} initial={initial} />
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function NotebookFields({ state, initial }: { state: ActionState; initial: NotebookFormValues }) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: "title" | "emoji" | "description" | "subteam") => v?.[key] ?? initial[key];
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);
  const [emoji, setEmoji] = useState(value("emoji"));

  return (
    <CardBody className="space-y-5">
      <Field label="Title" htmlFor="title" error={errors.title}>
        <Input
          id="title"
          name="title"
          required
          maxLength={LIMITS.notebookTitleMax}
          defaultValue={value("title")}
          invalid={!!errors.title}
          aria-describedby={described("title")}
          placeholder="e.g. Hardware Notebook"
          autoComplete="off"
        />
      </Field>

      <Field label="Emoji" htmlFor="emoji" error={errors.emoji} optional hint="Shown next to the title in the outline.">
        <Input
          id="emoji"
          name="emoji"
          maxLength={NOTEBOOK_EMOJI_MAX}
          value={emoji}
          onChange={(e) => setEmoji(e.currentTarget.value)}
          invalid={!!errors.emoji}
          aria-describedby={described("emoji")}
          placeholder={NOTEBOOK_DEFAULT_EMOJI}
          autoComplete="off"
          className="max-w-32 text-lg"
        />
      </Field>
      <div className="-mt-3 flex flex-wrap gap-1" role="group" aria-label="Pick an emoji">
        {EMOJI_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => setEmoji(choice)}
            aria-pressed={emoji === choice}
            aria-label={`Use ${choice}`}
            className={cn(
              "flex size-10 items-center justify-center rounded-lg border text-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
              emoji === choice ? "border-brand-400 bg-brand-50" : "border-ink-200 bg-white hover:bg-ink-50",
            )}
          >
            <span aria-hidden>{choice}</span>
          </button>
        ))}
      </div>

      <Field
        label="Whose notebook"
        htmlFor="subteam"
        error={errors.subteam}
        hint="That subteam's leaders can add, rename, and reorder its pages. Everyone can write in it."
      >
        <Select
          id="subteam"
          name="subteam"
          defaultValue={value("subteam")}
          invalid={!!errors.subteam}
          aria-describedby={described("subteam")}
          className="max-w-64"
        >
          <option value="">Whole team</option>
          {SUBTEAMS.map((s) => (
            <option key={s} value={s}>
              {SUBTEAM_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Description" htmlFor="description" error={errors.description} optional>
        <Textarea
          id="description"
          name="description"
          rows={2}
          maxLength={NOTEBOOK_DESCRIPTION_MAX}
          defaultValue={value("description")}
          invalid={!!errors.description}
          aria-describedby={described("description")}
          placeholder="What goes in this notebook"
        />
      </Field>
    </CardBody>
  );
}
