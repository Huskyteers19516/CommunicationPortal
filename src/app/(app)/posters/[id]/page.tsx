import { CalendarDays, Download, ExternalLink, FileText, Link2, Pencil, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { type DateOnly, daysBetween, formatDateOnly, formatDateTime, relativeDueLabel, todayInTimezone } from "@/lib/dates";
import { formatFileSize } from "@/lib/files";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getPosterDetail, type PosterDetail } from "@/server/queries/posters";
import { deletePosterAction } from "../actions";

// Shared by generateMetadata and the page so the poster loads once per request.
const loadPoster = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return getPosterDetail(actor, id);
});

export async function generateMetadata({ params }: PageProps<"/posters/[id]">): Promise<Metadata> {
  const { id } = await params;
  const poster = await loadPoster(id);
  return { title: poster?.title ?? "Poster" };
}

/** " (in 3 days)", " (today)", " (yesterday)" within a week of today; "" otherwise (the date says enough). */
function nearLabel(date: DateOnly, today: DateOnly): string {
  return Math.abs(daysBetween(today, date)) < 7 ? ` (${relativeDueLabel(date, today).toLowerCase()})` : "";
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** The poster itself: the picture (as big as fits the screen), or a card for a PDF or a link-only poster. */
function Preview({ p }: { p: PosterDetail }) {
  if (p.file?.kind === "image") {
    return (
      <div className="flex justify-center rounded-xl border border-ink-200 bg-ink-50 p-2 sm:p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; next/image can't fetch it */}
        <img
          src={p.file.viewHref}
          alt={`Poster: ${p.title}`}
          className="h-auto max-h-[75dvh] w-auto max-w-full rounded-lg object-contain"
        />
      </div>
    );
  }
  const message = p.file
    ? p.file.kind === "pdf"
      ? "This poster is a PDF. Open it to see it, or download it to print."
      : "Download the file to open it."
    : `This poster is a link to the design${p.linkHost ? ` on ${p.linkHost}` : ""}.`;
  const Icon = p.file ? FileText : Link2;
  return (
    <Card>
      <CardBody className="flex items-start gap-3 text-sm text-ink-600">
        <Icon className="mt-0.5 size-5 shrink-0 text-brand-700" aria-hidden />
        <div className="min-w-0">
          <p>{message}</p>
          {p.file && (
            <p className="mt-1 text-xs text-ink-500">
              <span className="font-mono text-ink-700 wrap-anywhere">{p.file.filename}</span>{" "}
              <span className="whitespace-nowrap">· {formatFileSize(p.file.size)}</span>
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export default async function PosterPage({ params, searchParams }: PageProps<"/posters/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const p = await loadPoster(id);
  if (!p) notFound();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone);
  const added = first(sp.added) === "1";
  const saved = first(sp.saved) === "1";

  return (
    <div className="mx-auto w-full max-w-4xl min-w-0 space-y-5">
      <div>
        <BackLink href="/posters">Posters</BackLink>
        {/* Takes focus: after Add or Save the page would otherwise open where the form was scrolled to. */}
        {(added || saved) && (
          <div className="mb-4">
            <FocusAlert tone="success">{added ? "Poster added. The whole team can see it now." : "Changes saved."}</FocusAlert>
          </div>
        )}
        <header className="min-w-0">
          <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink-900 wrap-anywhere sm:text-3xl">{p.title}</h1>
          {(p.event || p.eventDate) && (
            <p className="mt-1.5 flex min-w-0 items-start gap-1.5 text-sm font-medium text-ink-700 sm:text-base">
              <CalendarDays className="mt-0.5 size-4 shrink-0 text-brand-700 sm:mt-1" aria-hidden />
              <span className="min-w-0 wrap-anywhere">
                {p.event}
                {p.event && p.eventDate && " · "}
                {p.eventDate && (
                  <>
                    {formatDateOnly(p.eventDate, today)}
                    <span className="font-normal text-ink-500">{nearLabel(p.eventDate, today)}</span>
                  </>
                )}
              </span>
            </p>
          )}
          <p className="mt-1 text-sm text-ink-500">
            Added by <span className="font-medium text-ink-700">{p.createdByName ?? "a former member"}</span> ·{" "}
            {formatDateTime(p.createdAt, timeZone)}
          </p>
        </header>
      </div>

      {/* What people come here for (print it, open the design) goes first, above the big picture. */}
      <div className="flex flex-wrap gap-2">
        {p.file && (
          <a href={p.file.downloadHref} className={buttonClasses("primary", "md")}>
            <Download className="size-4" aria-hidden />
            Download
          </a>
        )}
        {p.file && p.file.kind !== "file" && (
          <a href={p.file.viewHref} target="_blank" rel="noopener" className={buttonClasses("secondary", "md")}>
            <ExternalLink className="size-4" aria-hidden />
            {p.file.kind === "pdf" ? "Open PDF" : "Open full size"}
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
        {p.link && (
          <a
            href={p.link}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClasses(p.file ? "secondary" : "primary", "md")}
          >
            <Link2 className="size-4" aria-hidden />
            Open design link
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>
      {p.link && <p className="-mt-2 text-xs text-ink-500 wrap-anywhere">{p.link}</p>}

      <Preview p={p} />

      {p.description && <p className="whitespace-pre-wrap text-sm text-ink-700 wrap-anywhere sm:text-base">{p.description}</p>}

      {p.canEdit && (
        <div className="flex flex-wrap items-start gap-2 border-t border-ink-200 pt-4">
          <ButtonLink href={`/posters/${p.id}/edit`} variant="secondary" aria-label={`Edit ${p.title}`}>
            <Pencil className="size-4" aria-hidden />
            Edit
          </ButtonLink>
          <ActionForm
            action={deletePosterAction}
            fields={{ posterId: p.id }}
            variant="ghost"
            confirm={`Remove “${p.title}” from Posters?`}
            pendingText="Removing…"
            aria-label={`Remove ${p.title}`}
          >
            <Trash2 className="size-4" aria-hidden />
            Remove
          </ActionForm>
        </div>
      )}
    </div>
  );
}
