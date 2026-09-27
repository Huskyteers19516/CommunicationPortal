import { Download, ExternalLink, FileQuestion, Paperclip, Pencil, Pin, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CodePreview } from "@/components/resources/code-preview";
import { ResourceIcon } from "@/components/resources/resource-icon";
import { ResourceReviewCard } from "@/components/resources/resource-review-card";
import { ResourceStatusBadge } from "@/components/resources/resource-status-badge";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { NoteBlock } from "@/components/tasks/note-block";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { formatDateTime } from "@/lib/dates";
import { formatFileSize } from "@/lib/files";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getResourceDetail, type ResourceDetail } from "@/server/queries/resources";
import { deleteResourceAction, reviewResourceAction } from "../actions";

// Shared by generateMetadata and the page so the resource loads once per request.
const loadResource = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return getResourceDetail(actor, id);
});

export async function generateMetadata({ params }: PageProps<"/resources/[id]">): Promise<Metadata> {
  const { id } = await params;
  const resource = await loadResource(id);
  return { title: resource?.title ?? "Resource" };
}

function firstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** For the person who shared it (reviewers get the review card at the end instead). */
function StatusBanner({ r }: { r: ResourceDetail }) {
  if (r.status === "PENDING") {
    return (
      <Alert tone="warning" title="Waiting for approval">
        A leader or admin will check it soon. Until then, only you and they can see it.
      </Alert>
    );
  }
  if (r.status === "REJECTED") {
    return (
      <Alert tone="error" title="Sent back">
        {r.reviewedByName ? `${r.reviewedByName} sent it back.` : "It was sent back."} Change it and save to send it again, or
        remove it.
      </Alert>
    );
  }
  return null;
}

/** Where a member's resource stands, inside the reviewer's card. */
function ReviewSummary({ r }: { r: ResourceDetail }) {
  const sharer = r.createdByName ?? "A former member";
  if (r.status === "REJECTED") {
    return (
      <>
        <p>{r.reviewedByName ? `${r.reviewedByName} sent it back.` : "It was sent back."} Approve it if it&apos;s ready now.</p>
        {r.reviewNote && <NoteBlock label={`Note for ${firstName(r.createdByName) ?? "the member"}`} text={r.reviewNote} tone="feedback" />}
      </>
    );
  }
  return (
    <>
      <p>{sharer} shared this. Should the whole team see it?</p>
      {r.reviewNote && <NoteBlock label={`Note from ${r.reviewedByName ?? "a reviewer"}`} text={r.reviewNote} />}
    </>
  );
}

function FilePreview({ r }: { r: ResourceDetail }) {
  if (!r.file || !r.preview) return null;
  const p = r.preview;
  if (p.kind === "text") return <CodePreview filename={r.file.filename} text={p.text} lineCount={p.lineCount} />;
  if (p.kind === "image" && r.fileViewHref) {
    return (
      <div className="flex justify-center rounded-xl border border-ink-200 bg-ink-50 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; next/image can't fetch it */}
        <img src={r.fileViewHref} alt={`Preview of ${r.file.filename}`} className="h-auto max-h-[70vh] w-auto max-w-full rounded-lg" />
      </div>
    );
  }
  const message =
    p.kind === "pdf"
      ? "Open the PDF to read it, or download it."
      : p.kind === "none" && p.reason === "too-big"
        ? "This file is too big to preview here. Download it to open it."
        : "There's no preview for this kind of file. Download it to open it.";
  return (
    <Card>
      <CardBody className="flex items-center gap-3 text-sm text-ink-600">
        <FileQuestion className="size-5 shrink-0 text-ink-400" aria-hidden />
        {message}
      </CardBody>
    </Card>
  );
}

export default async function ResourcePage({ params }: PageProps<"/resources/[id]">) {
  const { id } = await params;
  const r = await loadResource(id);
  if (!r) notFound();
  const timeZone = env.teamTimezone;

  return (
    <div className="mx-auto w-full max-w-4xl min-w-0 space-y-5">
      <div>
        <BackLink href="/resources">Resources</BackLink>
        <header className="flex items-start gap-3">
          <span className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
            <ResourceIcon type={r.type} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink-900 wrap-anywhere sm:text-3xl">{r.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge tone="blue">{r.kind === "file" ? "File" : "Link"}</Badge>
              <Badge tone="gray">{RESOURCE_TYPE_LABELS[r.type]}</Badge>
              {r.status !== "APPROVED" && <ResourceStatusBadge status={r.status} />}
              {r.pinned && (
                <Badge tone="brand">
                  <Pin className="size-3" aria-hidden />
                  Pinned
                </Badge>
              )}
            </div>
            <p className="mt-2 text-sm text-ink-500">
              Shared by <span className="font-medium text-ink-700">{r.createdByName ?? "a former member"}</span> ·{" "}
              {formatDateTime(r.createdAt, timeZone)}
              {r.status === "APPROVED" && r.reviewedByName && <> · approved by {r.reviewedByName}</>}
            </p>
          </div>
        </header>
      </div>

      {!r.isReviewer && <StatusBanner r={r} />}
      {!r.canReview && r.reviewNote && (
        <NoteBlock
          label={r.status === "REJECTED" ? "Why it was sent back" : `Note from ${r.reviewedByName ?? "the reviewer"}`}
          text={r.reviewNote}
          tone={r.status === "REJECTED" ? "feedback" : "neutral"}
        />
      )}

      {r.description && <p className="whitespace-pre-wrap wrap-anywhere text-sm text-ink-700 sm:text-base">{r.description}</p>}

      {r.kind === "link" ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-500 wrap-anywhere">{r.url}</p>
          <a href={r.href} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "md")}>
            <ExternalLink className="size-4" aria-hidden />
            Open link
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      ) : (
        r.file && (
          <div className="space-y-3">
            <p className="flex min-w-0 items-start gap-1.5 text-sm text-ink-600">
              <Paperclip className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden />
              <span className="min-w-0">
                <span className="font-mono text-ink-900 wrap-anywhere">{r.file.filename}</span>{" "}
                <span className="whitespace-nowrap">· {formatFileSize(r.file.size)}</span>
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {r.fileDownloadHref && (
                <a href={r.fileDownloadHref} className={buttonClasses("primary", "md")}>
                  <Download className="size-4" aria-hidden />
                  Download
                </a>
              )}
              {r.fileViewHref && (
                <a href={r.fileViewHref} target="_blank" rel="noopener" className={buttonClasses("secondary", "md")}>
                  <ExternalLink className="size-4" aria-hidden />
                  Open in a new tab
                </a>
              )}
            </div>
            <FilePreview r={r} />
          </div>
        )
      )}

      {r.links.length > 0 && (
        <section aria-labelledby="quick-links-heading">
          <h2 id="quick-links-heading" className="mb-2 text-sm font-semibold text-ink-800">
            Quick links
          </h2>
          <ul className="flex flex-wrap gap-2">
            {r.links.map((l, i) => (
              <li key={i} className="min-w-0 max-w-full">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-10 max-w-full items-center rounded-full border border-ink-200 bg-ink-50 wrap-anywhere px-3.5 py-1.5 text-sm font-medium text-ink-800 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* After the content: read it first, then decide. Mounted for every reviewer so the confirmation survives the refresh. */}
      {r.isReviewer && (
        <ResourceReviewCard
          resourceId={r.id}
          version={r.version}
          title={r.title}
          sharedByName={r.createdByName}
          reviewable={r.canReview}
          canSendBack={r.status === "PENDING"}
          heading={r.status === "REJECTED" ? "Sent back" : "Waiting for approval"}
          action={reviewResourceAction}
        >
          <ReviewSummary r={r} />
        </ResourceReviewCard>
      )}

      {(r.canEdit || r.canDelete) && (
        <div className="flex flex-wrap items-start gap-2 border-t border-ink-200 pt-4">
          {r.canEdit && (
            <ButtonLink href={`/resources/${r.id}/edit`} variant="secondary" aria-label={`Edit ${r.title}`}>
              <Pencil className="size-4" aria-hidden />
              Edit
            </ButtonLink>
          )}
          {r.canDelete && (
            <ActionForm
              action={deleteResourceAction}
              fields={{ resourceId: r.id }}
              variant="ghost"
              confirm={`Remove “${r.title}” from Resources?`}
              pendingText="Removing…"
              aria-label={`Remove ${r.title}`}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove
            </ActionForm>
          )}
        </div>
      )}
    </div>
  );
}
