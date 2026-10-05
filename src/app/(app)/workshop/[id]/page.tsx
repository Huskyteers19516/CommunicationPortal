import {
  CircleAlert,
  Clock,
  CodeXml,
  Download,
  ExternalLink,
  EyeOff,
  Globe,
  Images,
  Link2,
  type LucideIcon,
  PencilLine,
  Pencil,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { cache } from "react";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { BackLink } from "@/components/tasks/back-link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { WorkshopActionButton } from "@/components/workshop/action-button";
import { WorkshopFeaturedSwitch } from "@/components/workshop/featured-switch";
import { WorkshopFileAddForm } from "@/components/workshop/file-add-form";
import { WORKSHOP_FIELD_LABELS, WORKSHOP_KIND_ICONS, workshopSiteHref } from "@/components/workshop/kinds";
import { WorkshopPhotoAddForm } from "@/components/workshop/photo-add-form";
import { WorkshopPhotoControls } from "@/components/workshop/photo-controls";
import { WorkshopReviewPanel } from "@/components/workshop/review-panel";
import { FeaturedBadge, WorkshopStatusBadge } from "@/components/workshop/workshop-badges";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { formatFileSize } from "@/lib/files";
import { WORKSHOP_KIND_LABELS, WORKSHOP_LIMITS } from "@/lib/workshop";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getWorkshopProject, splitExtraCredits, type WorkshopProjectDetail } from "@/server/queries/workshop";
import {
  addWorkshopFileAction,
  addWorkshopPhotoAction,
  deleteWorkshopProjectAction,
  removeWorkshopFileAction,
  reviewWorkshopProjectAction,
  setWorkshopFeaturedAction,
  submitWorkshopProjectAction,
  unpublishWorkshopProjectAction,
} from "../actions";

// Shared by generateMetadata and the page so the project loads once per request.
const loadProject = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return getWorkshopProject(actor, id);
});

export async function generateMetadata({ params }: PageProps<"/workshop/[id]">): Promise<Metadata> {
  const { id } = await params;
  const project = await loadProject(id);
  return { title: project?.title ?? "Workshop project" };
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

const BACK_FOR_APPROVAL = "It's off the team website until a leader approves it again.";

/** What just happened (after a redirect from an action), by its flag in the address. */
function confirmation(sp: Record<string, string | string[] | undefined>, reviewer: boolean): string | null {
  const messages: Record<string, string> = {
    added: reviewer
      ? "Project added. Next: add photos below, then publish it to the team website."
      : "Project added. Next: add photos below, then send it for approval.",
    saved: "Changes saved.",
    resubmitted: `Changes saved. ${BACK_FOR_APPROVAL}`,
    sent: "Sent for approval. A leader will take a look soon.",
    published: "Published. It shows on the team website within a few minutes.",
    approved: "Approved. It shows on the team website within a few minutes.",
    returned: "Sent back with your note.",
    withdrawn: "Withdrawn. It's a draft again.",
    unpublished: "Taken off the team website. It's a draft again.",
  };
  const key = Object.keys(messages).find((k) => first(sp[k]) === "1");
  return key ? messages[key] : null;
}

/** "https://cad.onshape.com/documents/…" → "cad.onshape.com". */
function hostOf(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

export default async function WorkshopProjectPage({ params, searchParams }: PageProps<"/workshop/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const p = await loadProject(id);
  if (!p) notFound();
  const done = confirmation(sp, p.canReview);
  const KindIcon = WORKSHOP_KIND_ICONS[p.kind];

  return (
    // Keyed by what just happened: after a status change (a redirect back here) the forms start fresh, so an
    // earlier "Photo added." doesn't linger.
    <div key={done ?? ""} className="mx-auto w-full max-w-4xl min-w-0 space-y-5">
      <div>
        <BackLink href="/workshop">Workshop</BackLink>
        {/* Takes focus: after a save the page would otherwise open where the form was scrolled to. */}
        {done && (
          <div className="mb-4">
            <FocusAlert tone="success">{done}</FocusAlert>
          </div>
        )}
        <header className="min-w-0">
          <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink-900 wrap-anywhere sm:text-3xl">{p.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-700">
              <KindIcon className="size-4 text-brand-700" aria-hidden />
              {WORKSHOP_KIND_LABELS[p.kind]}
            </span>
            <WorkshopStatusBadge status={p.status} />
            {p.featured && <FeaturedBadge />}
          </div>
        </header>
      </div>

      <StatusBanner p={p} />
      <Details p={p} />
      <Photos p={p} />
      <DesignFiles p={p} />

      {p.canDelete && (
        <div className="flex flex-wrap items-start gap-2 border-t border-ink-200 pt-4">
          <WorkshopActionButton
            action={deleteWorkshopProjectAction}
            fields={{ projectId: p.id }}
            variant="ghost"
            confirm={`Remove “${p.title}” with all its photos and files? This can't be undone.`}
            pendingText="Removing…"
            aria-label={`Remove project “${p.title}”`}
          >
            <Trash2 className="size-4" aria-hidden />
            Remove project
          </WorkshopActionButton>
        </div>
      )}
    </div>
  );
}

// ---------- status ----------

const BANNER_TONES = {
  DRAFT: { box: "border-ink-200 bg-ink-50 text-ink-800", icon: PencilLine, iconClass: "text-ink-500" },
  PENDING: { box: "border-amber-200 bg-amber-50 text-amber-950", icon: Clock, iconClass: "text-amber-600" },
  APPROVED: { box: "border-brand-200 bg-brand-50 text-brand-950", icon: Globe, iconClass: "text-brand-700" },
  REJECTED: { box: "border-red-200 bg-red-50 text-red-950", icon: CircleAlert, iconClass: "text-red-600" },
} satisfies Record<WorkshopProjectDetail["status"], { box: string; icon: LucideIcon; iconClass: string }>;

/**
 * Sends a draft (or one sent back) for approval; reviewers publish it straight to the website, for the version they
 * see (refused, with the page refreshed, when it changed since).
 */
function SubmitControl({ p, again }: { p: WorkshopProjectDetail; again?: boolean }) {
  const noPhotos = p.photos.length === 0;
  return (
    <div className="space-y-1.5">
      <WorkshopActionButton
        action={submitWorkshopProjectAction}
        fields={p.canReview ? { projectId: p.id, version: p.updatedAt.toISOString() } : { projectId: p.id }}
        variant="primary"
        disabled={noPhotos}
        pendingText={p.canReview ? "Publishing…" : "Sending…"}
        buttonClassName="w-full sm:w-auto"
        className="w-full sm:w-auto"
      >
        {p.canReview ? <Globe className="size-4" aria-hidden /> : <Send className="size-4" aria-hidden />}
        {p.canReview ? "Publish to the team website" : again ? "Send for approval again" : "Send for approval"}
      </WorkshopActionButton>
      {noPhotos && <p className="text-xs">Add at least one photo below first: the website shows it on the project&apos;s card.</p>}
    </div>
  );
}

function StatusBanner({ p }: { p: WorkshopProjectDetail }) {
  const tone = BANNER_TONES[p.status];
  const Icon = tone.icon;
  let heading: string;
  let body: ReactNode;
  let actions: ReactNode = null;

  switch (p.status) {
    case "DRAFT":
      heading = "Draft";
      body = p.canReview
        ? "Only the people who made it and leaders can see it. Add photos, then publish it to the team website."
        : "Only you, the people credited, and leaders can see it. Add photos, then send it for approval.";
      if (p.canEdit) actions = <SubmitControl p={p} />;
      break;
    case "PENDING":
      heading = "Waiting for approval";
      body = p.canReview
        ? "Look over the photos, details, and files below, then approve it for the team website or send it back with a note."
        : "A leader, the captain, a mentor, or a teacher will look at it soon. It isn't on the team website yet.";
      if (p.canReview) {
        actions = (
          <WorkshopReviewPanel projectId={p.id} version={p.updatedAt.toISOString()} title={p.title} action={reviewWorkshopProjectAction} />
        );
      } else if (p.canEdit) {
        actions = (
          <WorkshopActionButton
            action={unpublishWorkshopProjectAction}
            fields={{ projectId: p.id, was: "pending" }}
            pendingText="Withdrawing…"
            buttonClassName="w-full sm:w-auto"
            className="w-full sm:w-auto"
          >
            <Undo2 className="size-4" aria-hidden />
            Withdraw
          </WorkshopActionButton>
        );
      }
      break;
    case "APPROVED":
      heading = "On the team website";
      body = (
        <>
          Everyone can see it on the team website&apos;s Workshop page.
          {p.canEdit && !p.canReview && (
            <>
              {" "}
              Adding or changing photos, files, or details sends it back for approval: it&apos;s off the website until a
              leader approves it again. Removing things and reordering photos don&apos;t.
            </>
          )}
        </>
      );
      actions = (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
            <a
              href={workshopSiteHref(p.id)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses("secondary", "md", "w-full sm:w-auto")}
            >
              <ExternalLink className="size-4" aria-hidden />
              View on the team website
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            {p.canEdit && (
              <WorkshopActionButton
                action={unpublishWorkshopProjectAction}
                fields={{ projectId: p.id, was: "approved" }}
                variant="ghost"
                confirm={`Take “${p.title}” off the team website? It goes back to being a draft.`}
                pendingText="Taking it off…"
                buttonClassName="w-full sm:w-auto"
                className="w-full sm:w-auto"
              >
                <EyeOff className="size-4" aria-hidden />
                Take off the website
              </WorkshopActionButton>
            )}
          </div>
          {p.canReview && (
            <div className="rounded-lg border border-brand-200 bg-white px-3 py-2">
              <WorkshopFeaturedSwitch projectId={p.id} featured={p.featured} action={setWorkshopFeaturedAction} />
            </div>
          )}
        </div>
      );
      break;
    case "REJECTED":
      heading = "Needs changes";
      body = (
        <>
          <span className="block">
            {p.reviewedByName ?? "A leader"} sent it back
            {p.reviewedAt && <> on {formatDateTime(p.reviewedAt, env.teamTimezone)}</>}:
          </span>
          {p.reviewNote && (
            <span className="mt-2 block whitespace-pre-wrap rounded-lg border border-red-200 bg-white px-3 py-2 text-ink-800 wrap-anywhere">
              {p.reviewNote}
            </span>
          )}
          <span className="mt-2 block">
            {p.canReview
              ? "Once it's fixed, publish it to the team website."
              : p.canEdit
                ? "Fix what's asked, then send it for approval again."
                : "It isn't on the team website."}
          </span>
        </>
      );
      if (p.canEdit) actions = <SubmitControl p={p} again />;
      break;
  }

  return (
    <section aria-labelledby="status-title" className={cn("space-y-3 rounded-xl border p-4 sm:p-5", tone.box)}>
      <div className="flex gap-3">
        <Icon className={cn("mt-0.5 size-5 shrink-0", tone.iconClass)} aria-hidden />
        <div className="min-w-0 text-sm">
          <h2 id="status-title" className="text-base font-semibold">
            {heading}
          </h2>
          <div className="mt-0.5 leading-relaxed">{body}</div>
        </div>
      </div>
      {actions && <div className="sm:pl-8">{actions}</div>}
    </section>
  );
}

// ---------- details ----------

function Item({ term, children, className }: { term: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">{term}</dt>
      <dd className="mt-1 text-sm text-ink-800 wrap-anywhere sm:text-base">{children}</dd>
    </div>
  );
}

function OutLink({ href, icon: Icon, children }: { href: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-10 min-w-0 items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm shadow-sm transition-colors hover:bg-ink-50"
    >
      <Icon className="size-4 shrink-0 text-brand-700" aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium text-ink-900">{children}</span>
        <span className="block truncate text-xs text-ink-500">{hostOf(href)}</span>
      </span>
      <ExternalLink className="ml-auto size-3.5 shrink-0 text-ink-400" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Details({ p }: { p: WorkshopProjectDetail }) {
  const labels = WORKSHOP_FIELD_LABELS[p.kind];
  const others = splitExtraCredits(p.extraCredits);
  const timeZone = env.teamTimezone;
  return (
    <section aria-labelledby="details-title">
      <Card>
        <CardHeader
          title={<span id="details-title">Details</span>}
          actions={
            p.canEdit && (
              <ButtonLink href={`/workshop/${encodeURIComponent(p.id)}/edit`} variant="secondary" className="px-3">
                <Pencil className="size-4" aria-hidden />
                Edit details
              </ButtonLink>
            )
          }
        />
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Item term={labels.summary} className="sm:col-span-2">
              <span className="whitespace-pre-wrap">{p.summary}</span>
            </Item>
            {p.material && <Item term={labels.material}>{p.material}</Item>}
            {p.season && <Item term="Season">{p.season}</Item>}
            <Item term="Credits" className="sm:col-span-2">
              {p.credits.length === 0 && others.length === 0 ? (
                <span className="text-ink-500">Nobody credited yet.</span>
              ) : (
                <>
                  {p.credits.map((c) => c.name).join(", ")}
                  {others.length > 0 && (
                    <span className={cn("block", p.credits.length > 0 && "mt-1 text-sm text-ink-600")}>
                      {p.credits.length > 0 ? "Also: " : ""}
                      {others.join(", ")}
                    </span>
                  )}
                </>
              )}
            </Item>
            {(p.link || p.codeLink) && (
              <Item term="Links" className="sm:col-span-2">
                <span className="mt-1 grid gap-2 sm:grid-cols-2">
                  {p.link && (
                    <OutLink href={p.link} icon={Link2}>
                      {labels.link}
                    </OutLink>
                  )}
                  {p.codeLink && (
                    <OutLink href={p.codeLink} icon={CodeXml}>
                      Source code
                    </OutLink>
                  )}
                </span>
              </Item>
            )}
            <Item term="Added by" className="sm:col-span-2">
              <span className="text-sm">
                <span className="font-medium">{p.createdByName ?? "a former member"}</span>
                <span className="text-ink-500"> · {formatDateTime(p.createdAt, timeZone)}</span>
              </span>
            </Item>
          </dl>
        </CardBody>
      </Card>
    </section>
  );
}

// ---------- photos ----------

function Photos({ p }: { p: WorkshopProjectDetail }) {
  const max = WORKSHOP_LIMITS.photosPerProject;
  const full = p.photos.length >= max;
  // A project on the website (or waiting for approval) keeps at least one photo: the service refuses removing the last.
  const keepsLast = p.photos.length === 1 && (p.status === "APPROVED" || p.status === "PENDING");
  return (
    <section aria-labelledby="photos-title">
      <Card>
        <CardHeader
          title={<span id="photos-title">Photos &amp; versions</span>}
          description={p.photos.length > 0 ? `${p.photos.length} of ${max} · first version first` : undefined}
        />
        <CardBody className="space-y-5">
          {p.canEdit && (
            <p className="text-sm text-ink-600">
              Add each version in order — Version 1 first. Say what failed and what you changed: the website shows the
              whole story.{" "}
              {p.kind === "PART"
                ? "The newest version is the cover unless you pick another."
                : "The first photo is the cover unless you pick another."}
            </p>
          )}
          {p.photos.length === 0 ? (
            <EmptyState
              icon={Images}
              title="No photos yet"
              description={p.canEdit ? "Add the first one below. A project needs a photo to go on the team website." : undefined}
              className="py-6"
            />
          ) : (
            <ol className="grid gap-4 sm:grid-cols-2">
              {p.photos.map((photo, i) => {
                const name = photo.label || `photo ${i + 1}`;
                return (
                  <li key={photo.id} className="min-w-0 overflow-hidden rounded-xl border border-ink-200 bg-white">
                    <a
                      href={photo.src}
                      target="_blank"
                      rel="noopener"
                      className="relative block aspect-[4/3] bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/50"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; next/image can't fetch it */}
                      <img
                        src={photo.src}
                        alt={photo.label || `Photo ${i + 1}`}
                        width={photo.width}
                        height={photo.height}
                        loading="lazy"
                        decoding="async"
                        className="absolute inset-0 size-full object-contain"
                      />
                      <span className="sr-only"> (opens full size in a new tab)</span>
                    </a>
                    <div className="space-y-3 p-3">
                      <div className="flex items-start gap-2.5">
                        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold tabular-nums text-ink-700">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={cn("text-sm font-semibold wrap-anywhere", photo.label ? "text-ink-900" : "text-ink-500")}>
                            {photo.label || "No label"}
                          </p>
                          {photo.note && <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-700 wrap-anywhere">{photo.note}</p>}
                        </div>
                        {photo.isCover && (
                          <Badge tone="brand" className="shrink-0">
                            Cover
                          </Badge>
                        )}
                      </div>
                      {p.canEdit && (
                        <WorkshopPhotoControls
                          photoId={photo.id}
                          name={name}
                          label={photo.label}
                          note={photo.note}
                          isCover={photo.isCover}
                          isFirst={i === 0}
                          isLast={i === p.photos.length - 1}
                          canRemove={!keepsLast}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {p.canEdit &&
            (full ? (
              <p className="border-t border-ink-100 pt-4 text-sm text-ink-600">
                This project has {max} photos, the most it can have. Remove one to add another.
              </p>
            ) : (
              <div className="space-y-3 border-t border-ink-100 pt-5">
                <h3 className="text-base font-semibold text-ink-900">Add a photo</h3>
                <WorkshopPhotoAddForm projectId={p.id} photoCount={p.photos.length} action={addWorkshopPhotoAction} />
              </div>
            ))}
        </CardBody>
      </Card>
    </section>
  );
}

// ---------- design files ----------

function DesignFiles({ p }: { p: WorkshopProjectDetail }) {
  const max = WORKSHOP_LIMITS.filesPerProject;
  const full = p.files.length >= max;
  return (
    <section aria-labelledby="files-title">
      <Card>
        <CardHeader
          title={<span id="files-title">Design files</span>}
          description={
            p.files.length === 0
              ? undefined
              : p.status === "APPROVED"
                ? "Anyone can download these from the team website."
                : "Anyone can download these from the team website once it's approved."
          }
        />
        {p.files.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-500">
              {p.canEdit ? "No design files yet. Add the STL, STEP, or a ZIP so others can make it too." : "No design files."}
            </p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-ink-100">
            {p.files.map((f) => (
              <li key={f.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <Badge tone="brand" className="mt-0.5 font-mono">
                    {f.format}
                  </Badge>
                  <div className="min-w-0">
                    <p className="font-medium text-ink-900 wrap-anywhere">{f.label || f.filename}</p>
                    <p className="text-xs text-ink-500 wrap-anywhere">
                      {f.label ? `${f.filename} · ` : ""}
                      {formatFileSize(f.size)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-start gap-2 sm:shrink-0 sm:justify-end">
                  <a href={f.href} download className={buttonClasses("secondary", "md", "px-3")}>
                    <Download className="size-4" aria-hidden />
                    Download
                    <span className="sr-only"> {f.filename}</span>
                  </a>
                  {p.canEdit && (
                    <WorkshopActionButton
                      action={removeWorkshopFileAction}
                      fields={{ fileId: f.id }}
                      variant="ghost"
                      buttonClassName="px-3"
                      confirm={`Remove ${f.filename}? This can't be undone.`}
                      pendingText="Removing…"
                      aria-label={`Remove ${f.filename}`}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      Remove
                    </WorkshopActionButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {p.canEdit && (
          <CardBody className="space-y-3 border-t border-ink-100">
            {full ? (
              <p className="text-sm text-ink-600">
                This project has {max} files, the most it can have. Zip some together, or remove one to add another.
              </p>
            ) : (
              <>
                <h3 className="text-base font-semibold text-ink-900">Add a design file</h3>
                <WorkshopFileAddForm projectId={p.id} action={addWorkshopFileAction} />
              </>
            )}
          </CardBody>
        )}
      </Card>
    </section>
  );
}
