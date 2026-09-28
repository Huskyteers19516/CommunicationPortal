"use client";

import { FilePlus2, FileText, Image as ImageIcon, LoaderCircle, RotateCcw, Route, Trash2, UsersRound, X } from "lucide-react";
import { type ChangeEvent, useActionState, useRef, useState } from "react";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, FieldError, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { LIMITS, STRATEGY_KIND_LABELS, STRATEGY_KINDS, type StrategyKind } from "@/lib/constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "@/lib/files";
import {
  isPedroPathFile,
  pedroPathProblem,
  STRATEGY_SAVE_MAX_BYTES,
  strategyFileProblem,
  strategySaveTooBigMessage,
  tooManyStrategyFilesMessage,
} from "@/lib/strategy";

export interface StrategyFormFile {
  id: string;
  filename: string;
  size: number;
  kind: "path" | "image" | "pdf" | "file";
}

export interface StrategyFormValues {
  id?: string;
  title: string;
  kind: StrategyKind;
  description: string;
  link: string;
  /** Editing: the files it has now (kept unless marked for removal). */
  currentFiles?: StrategyFormFile[];
  /** The other team it's about (Strategy → Other teams), or none for one of ours. Set when it's added. */
  team?: { id: string; label: string } | null;
}

interface Picked {
  key: string;
  file: File;
}

let pickCounter = 0;

function FileIcon({ name, kind }: { name: string; kind?: StrategyFormFile["kind"] }) {
  const k = kind ?? (isPedroPathFile(name) ? "path" : /\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : "file");
  const Icon = k === "path" ? Route : k === "image" ? ImageIcon : FileText;
  return <Icon className="mt-0.5 size-5 shrink-0 text-brand-700" aria-hidden />;
}

/** The text fields as they were sent, so a failed save (checked here, before sending) keeps them. */
function textValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) if (typeof value === "string" && !key.startsWith("$ACTION")) values[key] = value;
  return values;
}

/**
 * Add / edit a strategy: title, kind, description, an optional link, and files (Pedro Pathing .pp paths,
 * pictures, PDFs…). Picked files are checked right away (size; a .pp must be a path the planner can open) and
 * kept here, not in the file input, so they survive a save that comes back with an error. New files in one save
 * add up to 4 MB at most (one request); editing adds more. Removing a current file happens on save, with an undo.
 * Text values survive errors too, and focus goes to the first field to fix. The server checks everything again.
 */
export function StrategyForm({
  action,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initial: StrategyFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const current = initial.currentFiles ?? [];
  const keptCount = current.filter((f) => !removeIds.includes(f.id)).length;
  const newBytes = picked.reduce((sum, p) => sum + p.file.size, 0);
  // Problems with the list as a whole: saving is stopped here (the server would refuse, or the host the request).
  const listProblem =
    keptCount + picked.length > LIMITS.strategyFilesMax
      ? tooManyStrategyFilesMessage(keptCount)
      : newBytes > STRATEGY_SAVE_MAX_BYTES
        ? strategySaveTooBigMessage(newBytes)
        : null;

  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    if (listProblem) {
      return { ok: false, message: listProblem, fieldErrors: { files: listProblem }, values: textValues(formData), nonce: Date.now() };
    }
    formData.delete("files");
    for (const p of picked) formData.append("files", p.file);
    return action(prev, formData);
  }, initialActionState);

  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);

  return (
    <form ref={formRef} action={formAction} className="space-y-6" noValidate>
      <FormMessage state={state} />
      {initial.id && <input type="hidden" name="strategyId" value={initial.id} />}
      {!initial.id && initial.team && <input type="hidden" name="teamId" value={initial.team.id} />}
      {removeIds.map((id) => (
        <input key={id} type="hidden" name="removeFileIds" value={id} />
      ))}
      <Card>
        <CardBody className="space-y-5">
          {initial.team && (
            <p className="flex min-w-0 items-center gap-2 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">
              <UsersRound className="size-4 shrink-0 text-brand-700" aria-hidden />
              <span className="min-w-0 wrap-anywhere">
                About <span className="font-semibold text-ink-900">{initial.team.label}</span>
              </span>
            </p>
          )}
          <StrategyFields key={state?.nonce ?? 0} state={state} initial={initial} />
          <StrategyFilesPicker
            state={state}
            current={current}
            removeIds={removeIds}
            onRemoveIds={setRemoveIds}
            picked={picked}
            onPicked={setPicked}
            listProblem={listProblem}
          />
        </CardBody>
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText={picked.length > 0 ? "Uploading…" : "Saving…"}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function StrategyFields({ state, initial }: { state: ActionState; initial: StrategyFormValues }) {
  const v = state?.values;
  const errors = state?.fieldErrors ?? {};
  const value = (key: "title" | "kind" | "description" | "link") => v?.[key] ?? initial[key];
  const described = (key: string) => (errors[key] ? `${key}-error` : undefined);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <Field label="Title" htmlFor="title" error={errors.title}>
          <Input
            id="title"
            name="title"
            required
            maxLength={LIMITS.strategyTitleMax}
            defaultValue={value("title")}
            invalid={!!errors.title}
            aria-describedby={described("title")}
            placeholder="e.g. Red audience-side auto"
            autoComplete="off"
          />
        </Field>
        <Field label="Kind" htmlFor="kind" error={errors.kind}>
          <Select
            id="kind"
            name="kind"
            defaultValue={value("kind")}
            invalid={!!errors.kind}
            aria-describedby={described("kind")}
          >
            {STRATEGY_KINDS.map((k) => (
              <option key={k} value={k}>
                {STRATEGY_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="Description"
        htmlFor="description"
        error={errors.description}
        optional
        hint="What it does, when to use it, what to watch out for. Links become clickable."
      >
        <Textarea
          id="description"
          name="description"
          rows={6}
          maxLength={LIMITS.strategyDescriptionMax}
          defaultValue={value("description")}
          invalid={!!errors.description}
          aria-describedby={described("description")}
          placeholder="Start against the audience wall, score the preload, park by the HIVE…"
        />
      </Field>

      <Field label="Link" htmlFor="link" error={errors.link} optional hint="A match video, a doc, or a sheet.">
        <Input
          id="link"
          name="link"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={LIMITS.resourceUrlMax}
          defaultValue={value("link")}
          invalid={!!errors.link}
          aria-describedby={described("link")}
          placeholder="https://"
        />
      </Field>
    </div>
  );
}

function StrategyFilesPicker({
  state,
  current,
  removeIds,
  onRemoveIds,
  picked,
  onPicked,
  listProblem,
}: {
  state: ActionState;
  current: StrategyFormFile[];
  removeIds: string[];
  onRemoveIds: (ids: string[]) => void;
  picked: Picked[];
  onPicked: (picked: Picked[]) => void;
  listProblem: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  /** Reading picked .pp files to check them: the picker waits. */
  const [checking, setChecking] = useState(false);
  /** The result that was showing when the files last changed: its file error may no longer apply. */
  const [changedAtNonce, setChangedAtNonce] = useState<number | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");

  const serverError = state && !state.ok && state.nonce !== changedAtNonce ? state.fieldErrors?.files : undefined;
  const error = pickError ?? listProblem ?? serverError;
  const errorId = "files-error";
  const hintId = "files-hint";

  /** Focus a button in the files list (by its data-focus key), or the picker when it's gone. */
  function focusLater(key: string | null) {
    requestAnimationFrame(() => {
      const target = key ? listRef.current?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`) : null;
      (target ?? inputRef.current)?.focus();
    });
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const chosen = Array.from(input.files ?? []);
    // Kept in state, not the input (browsers clear it after a failed save); cleared so the same file can be picked again.
    input.value = "";
    if (chosen.length === 0) return;
    setChangedAtNonce(state?.nonce);
    setChecking(true);
    const problems: string[] = [];
    const accepted: Picked[] = [];
    for (const file of chosen) {
      let problem = strategyFileProblem(file);
      if (!problem && isPedroPathFile(file.name)) problem = pedroPathProblem(new Uint8Array(await file.arrayBuffer()), file.name);
      if (problem) problems.push(problem);
      else accepted.push({ key: `picked-${++pickCounter}`, file });
    }
    setChecking(false);
    onPicked([...picked, ...accepted]);
    const problem = problems.length > 0 ? problems.join(" ") : null;
    setPickError(problem);
    const added =
      accepted.length === 0 ? "" : accepted.length === 1 ? `Added “${accepted[0].file.name}”.` : `Added ${accepted.length} files.`;
    setAnnouncement([added, problem].filter(Boolean).join(" "));
  }

  function takeOff(index: number) {
    const gone = picked[index];
    const next = picked.filter((_, i) => i !== index);
    onPicked(next);
    setPickError(null);
    setChangedAtNonce(state?.nonce);
    setAnnouncement(`Took off “${gone.file.name}”.`);
    const neighbor = next[index] ?? next[index - 1];
    focusLater(neighbor ? `take-off-${neighbor.key}` : null);
  }

  function toggleRemove(file: StrategyFormFile, remove: boolean) {
    onRemoveIds(remove ? [...removeIds, file.id] : removeIds.filter((id) => id !== file.id));
    setChangedAtNonce(state?.nonce);
    setAnnouncement(remove ? `“${file.filename}” will be removed when you save.` : `Keeping “${file.filename}”.`);
    // The button is replaced by its opposite: keep keyboard focus on it.
    focusLater(`${remove ? "keep" : "remove"}-${file.id}`);
  }

  const hasList = current.length > 0 || picked.length > 0;

  return (
    <div className="space-y-2">
      <p id="files-label" className="text-sm font-medium text-ink-800">
        Files <span className="font-normal text-ink-500">(optional)</span>
      </p>

      {hasList && (
        <div ref={listRef}>
          <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200" aria-label="Files">
            {current.map((f) => {
              const removing = removeIds.includes(f.id);
              return (
                <li key={f.id} className={cn("flex items-start gap-3 p-3", removing && "bg-amber-50")}>
                  <FileIcon name={f.filename} kind={f.kind} />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className={cn("font-medium text-ink-900 wrap-anywhere", removing && "text-ink-500 line-through")}>{f.filename}</p>
                    <p className={cn("text-xs", removing ? "text-amber-900" : "text-ink-500")}>
                      {removing ? "Will be removed when you save" : `${formatFileSize(f.size)} · saved`}
                    </p>
                  </div>
                  {removing ? (
                    <Button variant="secondary" data-focus={`keep-${f.id}`} onClick={() => toggleRemove(f, false)} aria-label={`Keep ${f.filename}`}>
                      <RotateCcw className="size-4" aria-hidden />
                      Keep
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="sm:w-auto sm:gap-2 sm:px-3"
                      data-focus={`remove-${f.id}`}
                      onClick={() => toggleRemove(f, true)}
                      aria-label={`Remove ${f.filename}`}
                      title="Remove"
                    >
                      <Trash2 className="size-4" aria-hidden />
                      <span className="hidden sm:inline">Remove</span>
                    </Button>
                  )}
                </li>
              );
            })}
            {picked.map((p, index) => (
              <li key={p.key} className="flex items-start gap-3 bg-brand-50/40 p-3">
                <FileIcon name={p.file.name} />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium text-ink-900 wrap-anywhere">{p.file.name}</p>
                  <p className="text-xs text-ink-500">{formatFileSize(p.file.size)} · uploads when you save</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  data-focus={`take-off-${p.key}`}
                  onClick={() => takeOff(index)}
                  aria-label={`Take off ${p.file.name}`}
                  title="Take off"
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The real input is visually hidden; the label is the big button. Keyboard focus shows on the label. */}
      <div>
        <input
          ref={inputRef}
          id="files"
          type="file"
          multiple
          onChange={pick}
          onClick={(e) => {
            if (checking) e.preventDefault();
          }}
          aria-disabled={checking || undefined}
          aria-labelledby="files-label files-choose"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${hintId}` : hintId}
          className="peer sr-only"
        />
        <label
          id="files-choose"
          htmlFor="files"
          className={cn(
            "flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm font-medium transition-colors",
            "peer-focus:ring-2 peer-focus:ring-brand-500/40",
            checking && "cursor-wait opacity-60",
            error ? "border-red-400 text-red-700 hover:bg-red-50" : "border-brand-300 bg-brand-50/50 text-brand-800 hover:bg-brand-50",
          )}
        >
          {checking ? (
            <LoaderCircle className="size-5 shrink-0 animate-spin" aria-hidden />
          ) : (
            <FilePlus2 className="size-5 shrink-0" aria-hidden />
          )}
          {hasList ? "Add more files" : "Add files"}
        </label>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
      <p id={hintId} className="text-xs text-ink-500">
        {`Paths from the planner (.pp: its Save menu → Save As), field drawings, pictures, PDFs… Up to ${RESOURCE_FILE_MAX_MB} MB each and ${LIMITS.strategyFilesMax} per strategy.`}
      </p>
      {/* Always rendered, so screen readers announce what changes in it. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
