"use client";

import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useOptimistic, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS } from "@/lib/constants";
import type { NotificationPrefs, ResourceEmailScope } from "@/server/services/settings";

type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;
type PrefKey = keyof NotificationPrefs;
type SaveStatus = "saving" | "saved" | "error";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

interface PrefOption {
  key: PrefKey;
  label: string;
  description: string;
}

const GROUPS: { id: "everyone" | "staff" | "admin"; title: string; options: PrefOption[] }[] = [
  {
    id: "everyone",
    title: "Your tasks and questions",
    options: [
      {
        key: "emailOnReply",
        label: "Someone answers my question",
        description: "When a leader, mentor, or teacher replies to a question you asked.",
      },
      {
        key: "emailOnReview",
        label: "My checklist item or shared resource is reviewed",
        description: "When someone approves or sends back something you checked off or shared.",
      },
      {
        key: "emailOnAssigned",
        label: "I'm assigned a new task",
        description: "When a new task is added to your checklist.",
      },
    ],
  },
  {
    id: "staff",
    title: "For leaders",
    options: [
      {
        key: "emailOnQuestion",
        label: "Someone asks me or my subteam a question",
        description: "Includes follow-ups on questions you're helping with.",
      },
      {
        key: "emailOnSubmission",
        label: "Someone checks off a task I assigned or need to review",
        description: "So you can approve it or send it back.",
      },
    ],
  },
  {
    id: "admin",
    title: "Approvals",
    options: [
      {
        key: "emailOnSignup",
        label: "Someone signs up and needs approval",
        description: "New leader, mentor, and teacher accounts wait in Approvals.",
      },
      {
        key: "emailOnResource",
        label: "A member shares a resource",
        description: "Members' links and files wait for approval before the team sees them.",
      },
    ],
  },
];

/** "A member shares a resource": says whose shares reach this person (see resourceEmailScope). */
function resourceDescription(scope: ResourceEmailScope | null | undefined): string | undefined {
  if (scope?.kind === "subteam") return `Links and files from ${SUBTEAM_LABELS[scope.subteam]} members, waiting for approval.`;
  if (scope?.kind === "fallback") return "Only from members whose subteam has no active leader.";
  return undefined;
}

/**
 * Email notification switches. Only the groups this person can use are shown.
 *
 * Each switch saves as soon as it is flipped (the form is submitted with every visible switch), and a
 * small status line under that switch says "Saving…" / "Saved" / why it failed. The switches show the
 * saved preferences plus the change being saved; once the save finishes they fall back to `prefs` —
 * the new values after a success (the page is revalidated), the old ones after a failure — so they
 * always end up showing what is really saved. One save runs at a time: flips while a save is in
 * flight are ignored (the switch doesn't move).
 */
export function NotificationPrefsForm({
  action,
  prefs,
  showStaff,
  showAdmin,
  editableKeys,
  resourceScope,
}: {
  action: FormAction;
  prefs: NotificationPrefs;
  showStaff: boolean;
  showAdmin: boolean;
  /** Switches this person may change (editablePrefKeys). Others are hidden. Default: every switch in the shown groups. */
  editableKeys?: PrefKey[];
  /** Whose shared resources email this person (resourceEmailScope); tailors that switch's description. */
  resourceScope?: ResourceEmailScope | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, showSaving] = useOptimistic(prefs);
  const [result, setResult] = useState<ActionState>(null);
  /** The switch flipped last — its status line shows how the save went. */
  const [lastKey, setLastKey] = useState<PrefKey | null>(null);
  const groups = GROUPS.filter((g) => g.id === "everyone" || (g.id === "staff" && showStaff) || (g.id === "admin" && showAdmin))
    .map((g) => ({ ...g, options: editableKeys ? g.options.filter((o) => editableKeys.includes(o.key)) : g.options }))
    .filter((g) => g.options.length > 0)
    .map((g) => ({
      ...g,
      options: g.options.map((o) =>
        o.key === "emailOnResource" ? { ...o, description: resourceDescription(resourceScope) ?? o.description } : o,
      ),
    }));

  const status: SaveStatus | null = pending ? "saving" : result ? (result.ok ? "saved" : "error") : null;

  function onToggle(key: PrefKey, e: ChangeEvent<HTMLInputElement>) {
    if (pending) return; // A save is in flight: leave the switch as it is (no double submits).
    setLastKey(key);
    e.currentTarget.form?.requestSubmit();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const formData = new FormData(e.currentTarget);
    const next = { ...prefs };
    for (const group of groups) {
      for (const option of group.options) next[option.key] = formData.get(option.key) === "on";
    }
    startTransition(async () => {
      showSaving(next);
      let saved: ActionState;
      let reachedServer = true;
      try {
        saved = await action(result, formData);
      } catch {
        saved = { ok: false, message: OFFLINE_MESSAGE };
        reachedServer = false;
      }
      startTransition(() => {
        setResult(saved);
        // The server said no: pull the real saved state (and go to sign-in if the session ended).
        if (!saved?.ok && reachedServer) router.refresh();
      });
    });
  }

  return (
    <form onSubmit={onSubmit} aria-busy={pending} className="space-y-5">
      {groups.map((group) => (
        <fieldset key={group.id}>
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-500">{group.title}</legend>
          <div className="divide-y divide-ink-100">
            {group.options.map((option) => (
              <PrefSwitch
                key={option.key}
                option={option}
                checked={shown[option.key]}
                busy={pending}
                status={lastKey === option.key ? status : null}
                errorMessage={result?.message}
                onChange={(e) => onToggle(option.key, e)}
              />
            ))}
          </div>
        </fieldset>
      ))}
      <p className="text-sm text-ink-500">Changes save as soon as you flip a switch. Password reset and account emails are always sent.</p>
    </form>
  );
}

function PrefSwitch({
  option,
  checked,
  busy,
  status,
  errorMessage,
  onChange,
}: {
  option: PrefOption;
  checked: boolean;
  busy: boolean;
  status: SaveStatus | null;
  errorMessage?: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  const id = `pref-${option.key}`;
  return (
    <div className="py-3">
      <label
        htmlFor={id}
        className={cn("flex min-h-11 items-center justify-between gap-4", busy ? "cursor-progress" : "cursor-pointer")}
      >
        <span className="min-w-0">
          <span id={`${id}-label`} className="block text-sm font-medium text-ink-900">
            {option.label}
          </span>
          <span id={`${id}-desc`} className="mt-0.5 block text-sm text-ink-500">
            {option.description}
          </span>
        </span>
        <span className="relative inline-flex shrink-0 items-center">
          <input
            id={id}
            name={option.key}
            type="checkbox"
            role="switch"
            checked={checked}
            onChange={onChange}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-desc`}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="h-7 w-12 rounded-full bg-ink-300 transition-colors peer-checked:bg-brand-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute left-1 top-1 size-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
          />
        </span>
      </label>
      {/* Always rendered (empty when idle) so screen readers announce changes. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="text-xs">
        {status === "saving" && (
          <span className="mt-1.5 flex items-center gap-1.5 text-ink-500">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
            Saving…
          </span>
        )}
        {status === "saved" && (
          <span className="mt-1.5 flex items-center gap-1.5 font-medium text-brand-700">
            <CircleCheck className="size-3.5 shrink-0" aria-hidden />
            Saved
          </span>
        )}
        {status === "error" && (
          <span className="mt-1.5 flex items-start gap-1.5 font-medium text-red-700">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>Not saved. {errorMessage ?? "Please try again."}</span>
          </span>
        )}
      </p>
    </div>
  );
}
