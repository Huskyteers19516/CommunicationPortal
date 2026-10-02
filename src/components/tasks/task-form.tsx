"use client";

import { LoaderCircle } from "lucide-react";
import { type FormEvent, startTransition, useActionState, useMemo, useState } from "react";
import type { Priority, Subteam } from "@/generated/prisma/enums";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS, PRIORITY_LABELS, SUBTEAM_LABELS } from "@/lib/constants";
import type { DateOnly } from "@/lib/dates";
import { type AssignMode, NEW_CATEGORY } from "@/lib/task-form";
import type { TaskFormCategories } from "@/server/queries/categories";
import type { AssigneeGroup, SubteamOption } from "@/server/queries/tasks";
import { Alert } from "../ui/alert";
import { Button, ButtonLink } from "../ui/button";
import { Card, CardBody } from "../ui/card";
import { Field, FieldError, Input, Select, Textarea } from "../ui/field";
import { FormMessage } from "../ui/form-message";
import { AssigneePicker } from "./assignee-picker";
import type { FormAction } from "./types";

export interface TaskFormInitial {
  title: string;
  description: string;
  subteam: "" | Subteam;
  dueDate: DateOnly;
  priority: Priority;
  assigneeIds: string[];
  /** "" = no category. */
  categoryId: string;
  assignMode: AssignMode;
  /** Null = no limit. */
  signupLimit: number | null;
}

const PRIORITIES: Priority[] = ["LOW", "NORMAL", "HIGH"];

const MODES: { value: AssignMode; label: string; description: (subteamLabel: string | null) => string }[] = [
  { value: "assign", label: "Assign people", description: () => "You pick who does it." },
  {
    value: "signup",
    label: "Let people sign up",
    description: (subteamLabel) =>
      subteamLabel
        ? `${subteamLabel} members sign themselves up on the Task dashboard.`
        : "Anyone on the team signs up on the Task dashboard.",
  },
];

/**
 * People the actor may put only on whole-team tasks (`wholeTeamOnly`, the Business leader's view of other subteams)
 * are left out of the picker while the task is for a subteam — except anyone picked (or already on the task), who
 * stays listed with a note so nothing is dropped silently (the service then explains).
 */
function pickerGroups(groups: AssigneeGroup[], subteam: "" | Subteam, keep: Set<string>): AssigneeGroup[] {
  if (subteam === "") return groups;
  const note = `Not in ${SUBTEAM_LABELS[subteam]} — only on whole-team tasks`;
  return groups
    .map((g) => ({
      ...g,
      people: g.people
        .filter((p) => !p.wholeTeamOnly || keep.has(p.id))
        .map((p) => (p.wholeTeamOnly ? { ...p, note: p.note ?? note } : p)),
    }))
    .filter((g) => g.people.length > 0);
}

/** Create / edit a task. Used by /manage/tasks/new and /manage/tasks/[id]/edit. */
export function TaskForm({
  action,
  mode,
  taskId,
  initial,
  subteamOptions,
  newCategorySubteams,
  categories,
  groups,
  minDate,
  maxDate,
  cancelHref,
  signupClosed = false,
  finished = false,
}: {
  action: FormAction;
  mode: "create" | "edit";
  taskId?: string;
  initial: TaskFormInitial;
  subteamOptions: SubteamOption[];
  /** Subteam values whose categories the actor may add to ("New category…"). */
  newCategorySubteams: ("" | Subteam)[];
  /** Categories per subteam value ("" = whole team). */
  categories: TaskFormCategories;
  /** Everyone the actor may put on some task (see AssignablePerson.wholeTeamOnly). */
  groups: AssigneeGroup[];
  minDate: DateOnly;
  maxDate: DateOnly;
  cancelHref: string;
  /** Editing a sign-up task whose sign-ups are closed right now. */
  signupClosed?: boolean;
  /** Editing a task that's marked finished (nobody new can be added). */
  finished?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  const [subteam, setSubteam] = useState<"" | Subteam>(
    subteamOptions.some((o) => o.value === initial.subteam) ? initial.subteam : (subteamOptions[0]?.value ?? ""),
  );
  const categoryOptions = categories[subteam] ?? [];
  const [categoryId, setCategoryId] = useState(() =>
    initial.categoryId && (categories[subteam] ?? []).some((c) => c.id === initial.categoryId) ? initial.categoryId : "",
  );
  const [assignMode, setAssignMode] = useState<AssignMode>(initial.assignMode);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial.assigneeIds));
  // Whole-team-only people who stay listed on a subteam task: the ones picked when the subteam last changed.
  const [kept, setKept] = useState<Set<string>>(() => new Set(initial.assigneeIds));
  const hasWholeTeamOnly = useMemo(() => groups.some((g) => g.people.some((p) => p.wholeTeamOnly)), [groups]);
  const shownGroups = useMemo(() => {
    const base = hasWholeTeamOnly ? pickerGroups(groups, subteam, kept) : groups;
    if (!finished) return base;
    // A finished task takes nobody new (updateTask refuses): only the people already on it can be (un)checked.
    const onIt = new Set(initial.assigneeIds);
    return base.map((g) => ({ ...g, people: g.people.map((p) => (onIt.has(p.id) ? p : { ...p, frozen: true })) }));
  }, [groups, hasWholeTeamOnly, subteam, kept, finished, initial.assigneeIds]);
  const canAddCategory = newCategorySubteams.includes(subteam);
  // Spots as typed, so the picker's "Select all" doesn't offer more people than there are spots.
  const [spots, setSpots] = useState(initial.signupLimit === null ? "" : String(initial.signupLimit));
  const spotLimit = /^\d+$/.test(spots.trim()) && Number(spots) >= 1 ? Number(spots) : null;
  const values = state?.values;
  const errors = state?.fieldErrors;
  const removedCount = mode === "edit" ? initial.assigneeIds.filter((id) => !selected.has(id)).length : 0;
  const movedAway = mode === "edit" && !subteamOptions.some((o) => o.value === initial.subteam);
  const signup = assignMode === "signup";

  // Submit without React's automatic form reset so the picker's selection and every field
  // survive a validation error (success redirects away).
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(() => formAction(formData));
  }

  function changeSubteam(next: "" | Subteam) {
    setSubteam(next);
    // Categories belong to one subteam; a new one is created wherever the task goes (if the actor may add one there).
    if (categoryId !== NEW_CATEGORY || !newCategorySubteams.includes(next)) setCategoryId("");
    setKept(new Set([...initial.assigneeIds, ...selected]));
  }

  const onlySubteam = subteamOptions.length === 1 ? subteamOptions[0] : null;
  const subteamLabel = subteam ? SUBTEAM_LABELS[subteam] : null;
  // The Business leader on a Business task: people from other subteams only fit whole-team tasks — say how.
  const wholeTeamHint =
    hasWholeTeamOnly && subteam !== "" && !finished && subteamOptions.some((o) => o.value === "")
      ? "Need people from other subteams? Choose Whole team."
      : undefined;
  const signupHint = signup
    ? mode === "edit"
      ? "People who sign up while you edit stay on the task."
      : "Add anyone who's already doing it. Everyone else signs up themselves."
    : undefined;
  const pickerHint = [signupHint, wholeTeamHint].filter(Boolean).join(" ") || undefined;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {taskId && <input type="hidden" name="taskId" value={taskId} />}
      {mode === "edit" && (
        // The people this form was loaded with, so anyone who signs up (or leaves) meanwhile is respected.
        <>
          <input type="hidden" name="previousAssigneeIdsSent" value="1" />
          {initial.assigneeIds.map((id) => (
            <input key={id} type="hidden" name="previousAssigneeIds" value={id} />
          ))}
        </>
      )}
      <Card>
        <CardBody className="space-y-5">
          <Field label="Title" htmlFor="title" error={errors?.title}>
            <Input
              id="title"
              name="title"
              required
              maxLength={LIMITS.taskTitleMax}
              defaultValue={values?.title ?? initial.title}
              placeholder="e.g. Finish the intake CAD"
              invalid={!!errors?.title}
              aria-describedby={errors?.title ? "title-error" : undefined}
            />
          </Field>

          <Field
            label="Details"
            htmlFor="description"
            optional
            hint="Steps, links, what “done” looks like. Links become clickable."
            error={errors?.description}
          >
            <Textarea
              id="description"
              name="description"
              rows={4}
              maxLength={LIMITS.taskDescriptionMax}
              defaultValue={values?.description ?? initial.description}
              invalid={!!errors?.description}
              aria-describedby={errors?.description ? "description-error" : undefined}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Subteam" htmlFor="subteam" error={errors?.subteam}>
              {onlySubteam ? (
                <>
                  <input type="hidden" name="subteam" value={onlySubteam.value} />
                  <Input id="subteam" value={onlySubteam.label} readOnly disabled />
                </>
              ) : (
                <Select
                  id="subteam"
                  name="subteam"
                  value={subteam}
                  onChange={(e) => changeSubteam(e.target.value as "" | Subteam)}
                  invalid={!!errors?.subteam}
                >
                  {subteamOptions.map((o) => (
                    <option key={o.value || "team"} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Due date" htmlFor="dueDate" error={errors?.dueDate}>
              <Input
                id="dueDate"
                name="dueDate"
                type="date"
                required
                min={minDate}
                max={maxDate}
                defaultValue={values?.dueDate ?? initial.dueDate}
                invalid={!!errors?.dueDate}
                aria-describedby={errors?.dueDate ? "dueDate-error" : undefined}
              />
            </Field>
            <Field label="Priority" htmlFor="priority" error={errors?.priority}>
              <Select id="priority" name="priority" defaultValue={values?.priority ?? initial.priority} invalid={!!errors?.priority}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Category"
              htmlFor="categoryId"
              optional
              hint={categoryId === NEW_CATEGORY ? undefined : "Groups the task on the Task dashboard, e.g. Intake."}
              error={errors?.categoryId}
            >
              <Select
                id="categoryId"
                name="categoryId"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                invalid={!!errors?.categoryId}
                aria-describedby={errors?.categoryId ? "categoryId-error" : undefined}
              >
                <option value="">No category</option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {canAddCategory && <option value={NEW_CATEGORY}>New category…</option>}
              </Select>
            </Field>
            {categoryId === NEW_CATEGORY && canAddCategory && (
              <Field
                label="New category name"
                htmlFor="newCategory"
                hint={`Added to ${subteamLabel ?? "the whole-team"} categories when you save.`}
                error={errors?.newCategory}
              >
                <Input
                  id="newCategory"
                  name="newCategory"
                  required
                  maxLength={LIMITS.categoryNameMax}
                  defaultValue={values?.newCategory ?? ""}
                  placeholder="e.g. Intake"
                  autoComplete="off"
                  autoFocus
                  invalid={!!errors?.newCategory}
                  aria-describedby={errors?.newCategory ? "newCategory-error" : undefined}
                />
              </Field>
            )}
          </div>

          {movedAway && initial.subteam && (
            <Alert tone="warning">
              This task currently belongs to {SUBTEAM_LABELS[initial.subteam]}. Saving moves it to{" "}
              {subteamOptions.find((o) => o.value === subteam)?.label ?? "your subteam"}.
            </Alert>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <fieldset aria-describedby={errors?.assignMode ? "assignMode-error" : undefined}>
            <legend className="text-sm font-medium text-ink-800">Who does it?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {MODES.map((m) => {
                const checked = assignMode === m.value;
                return (
                  <label
                    key={m.value}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                      checked ? "border-brand-500 bg-brand-50/60 ring-1 ring-brand-500" : "border-ink-200 hover:bg-ink-50",
                    )}
                  >
                    <input
                      type="radio"
                      name="assignMode"
                      value={m.value}
                      checked={checked}
                      onChange={() => setAssignMode(m.value)}
                      className="mt-0.5 size-4 shrink-0 accent-brand-600"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink-900">{m.label}</span>
                      <span className="block text-xs text-ink-500">{m.description(subteamLabel)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <FieldError id="assignMode-error">{errors?.assignMode}</FieldError>
          </fieldset>

          {finished && (
            <Alert tone="info">
              This task is marked finished. You can still change it and take people off, but nobody new can be added until
              it&apos;s reopened.
            </Alert>
          )}

          {signup && signupClosed && (
            <Alert tone="info">Sign-ups for this task are closed right now, and saving keeps them closed. Use “Open sign-ups” on the task page to reopen them.</Alert>
          )}

          {signup && (
            <Field
              label="Spots"
              htmlFor="signupLimit"
              optional
              hint="Most people who can be on it, counting anyone you add below. Leave empty for no limit."
              error={errors?.signupLimit}
            >
              <Input
                id="signupLimit"
                name="signupLimit"
                type="number"
                inputMode="numeric"
                min={1}
                max={LIMITS.signupLimitMax}
                step={1}
                placeholder="No limit"
                defaultValue={values?.signupLimit ?? (initial.signupLimit === null ? "" : String(initial.signupLimit))}
                onChange={(e) => setSpots(e.target.value)}
                invalid={!!errors?.signupLimit}
                aria-describedby={errors?.signupLimit ? "signupLimit-error" : undefined}
                className="sm:w-40"
              />
            </Field>
          )}

          <div className="border-t border-ink-100 pt-4">
            <AssigneePicker
              // Remount when people outside the subteam come or go, starting from who's picked now.
              key={hasWholeTeamOnly && subteam !== "" ? "subteam" : "team"}
              groups={shownGroups}
              defaultSelected={[...selected]}
              taskSubteam={onlySubteam ? undefined : subteam}
              error={errors?.assigneeIds}
              label={signup ? "Already on it" : "Assign to"}
              optional={signup}
              maxSelected={signup ? spotLimit : null}
              hint={pickerHint}
              onSelectionChange={setSelected}
            />
          </div>
          {mode === "edit" &&
            (removedCount > 0 ? (
              <Alert tone="warning" title={`${removedCount} ${removedCount === 1 ? "person" : "people"} will be removed`}>
                Saving deletes their checklist item for this task, including anything they already submitted.
              </Alert>
            ) : (
              <p className="text-xs text-ink-500">
                Unchecking someone removes the task from their checklist (and deletes anything they submitted for it).
              </p>
            ))}
        </CardBody>
      </Card>

      <FormMessage state={state} />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary" className="sm:w-auto">
          Cancel
        </ButtonLink>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          {mode === "create"
            ? pending
              ? "Creating…"
              : signup
                ? "Create sign-up task"
                : `Create task${selected.size ? ` for ${selected.size}` : ""}`
            : pending
              ? "Saving…"
              : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
