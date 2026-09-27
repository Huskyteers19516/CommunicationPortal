import { Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ActionState } from "@/lib/action-state";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { timeAgo } from "@/lib/dates";
import type { ResourceItem } from "@/server/queries/resources";
import { ActionForm } from "../tasks/action-form";
import { NoteBlock } from "../tasks/note-block";
import { Badge } from "../ui/badge";
import { buttonClasses } from "../ui/button";
import { ResourceFileButtons, ResourceSource } from "./resource-card";
import { ResourceIcon } from "./resource-icon";
import { QueueReviewActions } from "./resource-review-queue";
import { ResourceStatusBadge } from "./resource-status-badge";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

function KindBadge({ kind }: { kind: ResourceItem["kind"] }) {
  return <Badge tone="blue">{kind === "file" ? "File" : "Link"}</Badge>;
}

/** Icon + details; `footer` spans the whole card (not indented under the icon). */
function Shell({ item, children, footer }: { item: ResourceItem; children: ReactNode; footer?: ReactNode }) {
  return (
    <li className="min-w-0 rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-600">
          <ResourceIcon type={item.type} />
        </span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {footer && <div className="mt-3 border-t border-ink-100 pt-3">{footer}</div>}
    </li>
  );
}

function Title({ item }: { item: ResourceItem }) {
  return (
    <Link href={`/resources/${item.id}`} className="font-semibold text-ink-900 wrap-anywhere hover:text-brand-700">
      {item.title}
    </Link>
  );
}

/** A member's resource in the reviewers' "Waiting for approval" list (inside <ResourceReviewQueue>). */
export function PendingResourceItem({ item, now, timeZone }: { item: ResourceItem; now: Date; timeZone: string }) {
  return (
    <Shell
      item={item}
      footer={<QueueReviewActions resourceId={item.id} version={item.version} title={item.title} sharedByName={item.createdByName} />}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <Title item={item} />
        <div className="flex shrink-0 items-center gap-2">
          <KindBadge kind={item.kind} />
          <Badge tone="gray">{RESOURCE_TYPE_LABELS[item.type]}</Badge>
        </div>
      </div>
      <p className="mt-0.5 text-xs text-ink-500">
        Shared by <span className="font-medium text-ink-700">{item.createdByName ?? "a former member"}</span> ·{" "}
        {timeAgo(item.createdAt, now, timeZone)}
      </p>
      {item.kind === "link" ? (
        <a
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 block text-sm text-brand-700 underline underline-offset-2 wrap-anywhere hover:text-brand-800"
        >
          {item.href}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <ResourceSource item={item} />
      )}
      {item.description && <p className="mt-2 line-clamp-4 whitespace-pre-wrap wrap-anywhere text-sm text-ink-700">{item.description}</p>}
      {item.kind === "file" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <ResourceFileButtons item={item} />
        </div>
      )}
    </Shell>
  );
}

/** One of the viewer's own resources that is waiting or was sent back (the section intro explains waiting). */
export function MyResourceItem({ item, deleteAction }: { item: ResourceItem; deleteAction: Action }) {
  return (
    <Shell item={item}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <Title item={item} />
        <div className="flex shrink-0 items-center gap-2">
          <ResourceStatusBadge status={item.status} />
        </div>
      </div>
      <ResourceSource item={item} />
      {item.status === "REJECTED" && (
        <>
          {item.reviewNote && <NoteBlock label="Why it was sent back" text={item.reviewNote} tone="feedback" className="mt-2" />}
          <p className="mt-2 text-sm text-ink-600">Change it and save to send it again, or remove it.</p>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <Link href={`/resources/${item.id}/edit`} className={buttonClasses("secondary", "md")} aria-label={`Edit ${item.title}`}>
          <Pencil className="size-4" aria-hidden />
          Edit
        </Link>
        <ActionForm
          action={deleteAction}
          fields={{ resourceId: item.id }}
          variant="ghost"
          confirm={`Remove “${item.title}”?`}
          pendingText="Removing…"
          aria-label={`Remove ${item.title}`}
        >
          <Trash2 className="size-4" aria-hidden />
          Remove
        </ActionForm>
      </div>
    </Shell>
  );
}
