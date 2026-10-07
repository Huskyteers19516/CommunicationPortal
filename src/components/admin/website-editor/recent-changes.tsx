"use client";

// "Recent changes" in Website Coding: who changed which spot, when, from what to what — with Undo on each (it puts
// back what was there before that change, as a new change of its own).
import { History, Undo2 } from "lucide-react";
import { useActionState } from "react";
import { revertSiteContentEditAction } from "@/app/(app)/admin/website/actions";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { formatDateTime, timeAgo } from "@/lib/dates";
import type { SiteContentEditRow } from "@/server/queries/site-content";
import { adminSiteImageUrl } from "./preview";

const SHORT = 70;

function short(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > SHORT ? `${flat.slice(0, SHORT - 1)}…` : flat;
}

function Value({ kind, value }: { kind: SiteContentEditRow["kind"]; value: string | null }) {
  if (value === null) return <span className="italic text-ink-500">original</span>;
  if (kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a Website Coding picture from this portal
      <img src={adminSiteImageUrl(value)} alt="" className="inline-block h-8 w-auto max-w-16 rounded border border-ink-200 align-middle object-contain" />
    );
  }
  return <span className="wrap-anywhere text-ink-800">&ldquo;{short(value)}&rdquo;</span>;
}

export function RecentChanges({ edits, timeZone }: { edits: SiteContentEditRow[]; timeZone: string }) {
  return (
    <Card>
      <CardHeader title="Recent changes" description="Undo puts back what was there before that change." />
      {edits.length === 0 ? (
        <EmptyState icon={History} title="No changes yet" description="Everything you change on the website shows up here." className="py-6" />
      ) : (
        <ul className="divide-y divide-ink-100">
          {edits.map((e) => (
            <EditRow key={e.id} edit={e} timeZone={timeZone} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function EditRow({ edit, timeZone }: { edit: SiteContentEditRow; timeZone: string }) {
  const [state, formAction] = useActionState(revertSiteContentEditAction, initialActionState);
  const at = new Date(edit.createdAt);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:px-5">
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="text-ink-600">
          <span className="font-medium text-ink-900">{edit.editorName ?? "Someone"}</span>{" "}
          <time dateTime={edit.createdAt} title={formatDateTime(at, timeZone)} suppressHydrationWarning>
            {timeAgo(at, new Date(), timeZone)}
          </time>{" "}
          · <span className="font-mono text-xs wrap-anywhere">{edit.key}</span>
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <Value kind={edit.kind} value={edit.before} />
          <span aria-label="changed to" className="text-ink-400">
            →
          </span>
          <Value kind={edit.kind} value={edit.after} />
        </p>
        <FormMessage state={state} />
      </div>
      <form action={formAction} className="shrink-0">
        <input type="hidden" name="editId" value={edit.id} />
        <SubmitButton
          variant="secondary"
          pendingText="Undoing…"
          disabled={!edit.beforeAvailable}
          title={edit.beforeAvailable ? undefined : "That picture was removed to save space"}
        >
          <Undo2 className="size-4" aria-hidden />
          Undo
        </SubmitButton>
      </form>
    </li>
  );
}
