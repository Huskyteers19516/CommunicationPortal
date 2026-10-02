"use client";

import { Crown, Megaphone, Send, UserRound, Users, type LucideIcon } from "lucide-react";
import { useActionState, useState } from "react";
import type { Subteam } from "@/generated/prisma/enums";
import { ButtonLink } from "@/components/ui/button";
import { Field, FieldError, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS, SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { type DateOnly, formatDateOnly } from "@/lib/dates";
import type { AskAboutTask, AskTaskOption, RecipientGroup } from "@/server/queries/questions";

/**
 * "leaders" = the asker's own subteam leaders; "taskLeaders" = the leaders of the task asked about; "poster" = the
 * subteam leader who posted the whole-team task asked about (e.g. the Business leader's fundraiser) — sent to them.
 */
type Choice = "leaders" | "taskLeaders" | "captain" | "person" | "poster";

export interface AskQuestionFormProps {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  actorSubteam: Subteam | null;
  /** The asker leads their subteam (so "Build leaders" means their fellow leaders). */
  actorIsLeader: boolean;
  actorIsCaptain: boolean;
  recipientGroups: RecipientGroup[];
  tasks: AskTaskOption[];
  defaultTaskId: string | null;
  /** Asked from a task's page: shown at the top, and its subteam's leaders (or the captain) are picked. */
  aboutTask?: AskAboutTask | null;
  /** Where Cancel goes (back to the task when asked from one). */
  cancelHref?: string;
  today: DateOnly;
  /** Questions to leaders/the captain are also posted to the leaders-only Discord channel. */
  discordEnabled?: boolean;
}

function ChoiceCard({
  value,
  checked,
  disabled,
  onSelect,
  icon: Icon,
  title,
  description,
}: {
  value: Choice;
  checked: boolean;
  disabled?: boolean;
  onSelect: (value: Choice) => void;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <label
      className={cn(
        "flex min-h-14 items-start gap-3 rounded-xl border bg-white p-3.5 shadow-sm transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-ink-300",
        checked ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500" : "border-ink-200",
      )}
    >
      <input
        type="radio"
        name="choice"
        value={value}
        // Uncontrolled on purpose: React resets forms after an action, and defaultChecked keeps the choice.
        defaultChecked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="mt-1 size-4 shrink-0"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-ink-900">
          <Icon className={cn("size-4 shrink-0", checked ? "text-brand-600" : "text-ink-400")} aria-hidden />
          {title}
        </span>
        <span className="mt-0.5 block text-sm text-ink-500">{description}</span>
      </span>
    </label>
  );
}

export function AskQuestionForm({
  action,
  actorSubteam,
  actorIsLeader,
  actorIsCaptain,
  recipientGroups,
  tasks,
  defaultTaskId,
  aboutTask = null,
  cancelHref = "/questions",
  today,
  discordEnabled = false,
}: AskQuestionFormProps) {
  const [state, formAction] = useActionState(action, initialActionState);

  const hasSubteamLeaders = !!actorSubteam && recipientGroups.some((g) => g.key === "subteam");
  const hasCaptain = recipientGroups.some((g) => g.key === "captain");
  const hasAnyone = recipientGroups.length > 0;
  const noLeaders: Choice = !actorIsCaptain ? "captain" : "person";
  const fallback: Choice = hasSubteamLeaders ? "leaders" : noLeaders;
  // Another subteam's task goes to that subteam's leaders (the asker's own leaders don't run it).
  const taskSubteam = aboutTask?.subteam ?? null;
  const otherSubteamTask = !!taskSubteam && taskSubteam !== actorSubteam;
  const offerTaskLeaders = otherSubteamTask && !!aboutTask?.subteamHasLeaders;
  // A whole-team task a subteam leader posted: they run it (the captain may not even know about it).
  const poster = aboutTask && taskSubteam === null ? aboutTask.poster : null;
  const initialChoice: Choice = !aboutTask
    ? fallback
    : poster
      ? "poster"
      : taskSubteam === null
        ? noLeaders // whole-team task → the captain
        : offerTaskLeaders
          ? "taskLeaders"
          : otherSubteamTask
            ? noLeaders // that subteam has no leaders yet
            : fallback;
  const [choice, setChoice] = useState<Choice>(initialChoice);

  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const upcoming = tasks.filter((t) => t.upcoming);
  const recent = tasks.filter((t) => !t.upcoming);
  const taskDefault = v?.taskId ?? (defaultTaskId && tasks.some((t) => t.taskId === defaultTaskId) ? defaultTaskId : "");
  // Which task is picked below, so "About:" at the top only shows while it's still the one from the task page.
  const [pickedTaskId, setPickedTaskId] = useState(taskDefault);
  const choiceCount = (poster ? 1 : 0) + (actorSubteam ? 1 : 0) + (offerTaskLeaders ? 1 : 0) + (actorIsCaptain ? 0 : 1) + 1;
  const toOnePerson = choice === "person" || choice === "poster";
  const taskLabel = (t: AskTaskOption) => `${t.title} · due ${formatDateOnly(t.dueDate, today)}`;
  // React resets the form after every submit, but a <select> only applies defaultValue when it mounts.
  // A new key per submission remounts the selects so they come back with what the user picked.
  const selectsKey = state?.nonce ?? 0;

  return (
    <form action={formAction} className="space-y-6">
      <FormMessage state={state} />

      {aboutTask && pickedTaskId === aboutTask.id && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 px-3.5 py-2.5 text-sm">
          <p className="text-ink-800 wrap-anywhere">
            <span className="text-ink-500">About: </span>
            <span className="font-medium">{aboutTask.title}</span>
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            {taskSubteam ? `${SUBTEAM_LABELS[taskSubteam]} task` : "Whole-team task"} · posted by {aboutTask.createdByName}
          </p>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-ink-800">Who should answer?</legend>
        <input type="hidden" name="to" value={toOnePerson ? "person" : "subteam"} />
        {choice === "poster" && poster && (
          <>
            <input type="hidden" name="recipientId" value={poster.id} />
            <input type="hidden" name="subteam" value="" />
          </>
        )}
        {choice === "leaders" && <input type="hidden" name="subteam" value={actorSubteam ?? ""} />}
        {choice === "taskLeaders" && <input type="hidden" name="subteam" value={taskSubteam ?? ""} />}
        {choice === "captain" && <input type="hidden" name="subteam" value="" />}

        <div className={cn("grid gap-2", choiceCount > 3 ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
          {poster && (
            <ChoiceCard
              value="poster"
              checked={choice === "poster"}
              onSelect={setChoice}
              icon={Megaphone}
              title={poster.name}
              description="Posted this task — they run it."
            />
          )}
          {offerTaskLeaders && taskSubteam && (
            <ChoiceCard
              value="taskLeaders"
              checked={choice === "taskLeaders"}
              onSelect={setChoice}
              icon={Users}
              title={`${SUBTEAM_LABELS[taskSubteam]} leaders`}
              description="They run this task."
            />
          )}
          {actorSubteam && (
            <ChoiceCard
              value="leaders"
              checked={choice === "leaders"}
              disabled={!hasSubteamLeaders}
              onSelect={setChoice}
              icon={Users}
              title={`${SUBTEAM_LABELS[actorSubteam]} leaders`}
              description={
                !hasSubteamLeaders
                  ? "No active leaders here yet."
                  : actorIsLeader
                    ? "Your fellow subteam leaders."
                    : "Your subteam's leaders."
              }
            />
          )}
          {!actorIsCaptain && (
            <ChoiceCard
              value="captain"
              checked={choice === "captain"}
              onSelect={setChoice}
              icon={Crown}
              title="Captain"
              description={
                !hasCaptain
                  ? "No captain yet — mentors and teachers will see it."
                  : aboutTask && taskSubteam === null && !poster
                    ? "They run whole-team tasks."
                    : "For whole-team questions."
              }
            />
          )}
          <ChoiceCard
            value="person"
            checked={choice === "person"}
            disabled={!hasAnyone}
            onSelect={setChoice}
            icon={UserRound}
            title="A specific person"
            description="Pick a leader, mentor, or teacher."
          />
        </div>
        <FieldError id="to-error">{errors.to}</FieldError>
        {discordEnabled && (
          <p className="text-xs text-ink-500">
            {toOnePerson
              ? "Questions to one person stay in the portal. They're not posted to the leaders' Discord channel."
              : "It's also posted in the leaders-only Discord channel so any leader can help."}
          </p>
        )}
      </fieldset>

      {choice === "person" && (
        <div key={selectsKey} className="grid gap-4 sm:grid-cols-2">
          <Field label="Person" htmlFor="recipientId" error={errors.recipientId} hint="They'll get an email.">
            <Select
              id="recipientId"
              name="recipientId"
              defaultValue={v?.recipientId ?? ""}
              invalid={!!errors.recipientId}
              aria-describedby="recipientId-error"
            >
              <option value="">Choose a person…</option>
              {recipientGroups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} · {o.roleLabel}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Topic" htmlFor="subteam" error={errors.subteam} hint="That subteam's leaders can see it too.">
            <Select
              id="subteam"
              name="subteam"
              defaultValue={v?.subteam ?? (aboutTask ? (taskSubteam ?? "") : (actorSubteam ?? ""))}
              invalid={!!errors.subteam}
              aria-describedby="subteam-error"
            >
              {SUBTEAMS.map((s) => (
                <option key={s} value={s}>
                  {SUBTEAM_LABELS[s]}
                </option>
              ))}
              <option value="">Whole team</option>
            </Select>
          </Field>
        </div>
      )}
      {choice !== "person" && <FieldError id="subteam-error">{errors.subteam}</FieldError>}

      <Field label="Title" htmlFor="title" error={errors.title}>
        <Input
          id="title"
          name="title"
          defaultValue={v?.title ?? ""}
          maxLength={LIMITS.questionTitleMax}
          placeholder="e.g. How tight should the chain be?"
          invalid={!!errors.title}
          aria-describedby="title-error"
          autoComplete="off"
        />
      </Field>

      <Field label="Details" htmlFor="body" error={errors.body} hint="Include what you've tried so far — it helps your leaders answer faster.">
        <Textarea
          id="body"
          name="body"
          rows={6}
          defaultValue={v?.body ?? ""}
          maxLength={LIMITS.questionBodyMax}
          placeholder="What are you stuck on? Include what you've tried."
          invalid={!!errors.body}
          aria-describedby="body-error"
        />
      </Field>

      {tasks.length > 0 && (
        <Field key={selectsKey} label="Related task" htmlFor="taskId" optional error={errors.taskId}>
          <Select
            id="taskId"
            name="taskId"
            defaultValue={taskDefault}
            onChange={(e) => setPickedTaskId(e.target.value)}
            invalid={!!errors.taskId}
            aria-describedby="taskId-error"
          >
            <option value="">No related task</option>
            {upcoming.length > 0 && (
              <optgroup label="Coming up">
                {upcoming.map((t) => (
                  <option key={t.taskId} value={t.taskId}>
                    {taskLabel(t)}
                  </option>
                ))}
              </optgroup>
            )}
            {recent.length > 0 && (
              <optgroup label="Last 30 days">
                {recent.map((t) => (
                  <option key={t.taskId} value={t.taskId}>
                    {taskLabel(t)}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary" className="w-full sm:w-auto">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Sending…" className="w-full sm:w-auto">
          <Send className="size-4" aria-hidden />
          Send question
        </SubmitButton>
      </div>
    </form>
  );
}
