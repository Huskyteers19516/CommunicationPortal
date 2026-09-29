import { Download, ExternalLink, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { deletePlannerPathAction } from "@/app/(app)/strategy/paths/actions";
import { ActionForm } from "@/components/tasks/action-form";
import { Badge } from "@/components/ui/badge";
import { buttonClasses, ButtonLink } from "@/components/ui/button";
import { timeAgo } from "@/lib/dates";
import { formatFileSize } from "@/lib/files";
import { plannerOpenHref, plannerPathDownloadHref, plannerPathRemoveQuestion, plannerPathWhose } from "@/lib/planner-paths";
import type { PlannerPathRow } from "@/server/queries/planner-paths";

/** Where a list is shown, so Edit and Remove come back to it: the Paths tab (with its filters) or a team's page. */
export type PlannerPathListFrom = { page: "paths"; team?: string; q?: string } | { page: "team" };

/** "You · saved 3 h ago", "Aiden Nguyen · updated by Maya Patel 2 d ago". */
function savedLine(p: PlannerPathRow, now: Date, timeZone: string): string {
  const who = p.mine ? "You" : (p.createdByName ?? "A former member");
  const when = timeAgo(p.updatedAt, now, timeZone);
  if (p.updatedAt.getTime() <= p.createdAt.getTime()) return `${who} · saved ${when}`;
  const by = p.updatedByName && p.updatedByName !== p.createdByName ? `by ${p.updatedByName} ` : "";
  return `${who} · updated ${by}${when}`;
}

function editHref(id: string, from: PlannerPathListFrom): string {
  const base = `/strategy/paths/${encodeURIComponent(id)}/edit`;
  return from.page === "team" ? `${base}?from=team` : base;
}

/**
 * Saved paths as cards (one column on phones, two on wide screens): whose path it is (ours, or the other team's,
 * linking to their page), name, notes, who saved it and when, its size; Open in planner (a new tab), Download .pp,
 * and — for whoever may change it — Edit and Remove. `showTeam: false` leaves out whose it is (a team's own page).
 */
export function PlannerPathList({
  paths,
  now,
  timeZone,
  from,
  showTeam = true,
}: {
  paths: PlannerPathRow[];
  now: Date;
  timeZone: string;
  from: PlannerPathListFrom;
  showTeam?: boolean;
}) {
  const removeFields: Record<string, string> =
    from.page === "team" ? { from: "team" } : { from: "paths", ...(from.team ? { team: from.team } : {}), ...(from.q ? { q: from.q } : {}) };
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {paths.map((p) => {
        const nameId = `path-${p.id}-name`;
        return (
          <li key={p.id} className="min-w-0">
            <article
              aria-labelledby={nameId}
              className="flex h-full min-w-0 flex-col gap-2 rounded-xl border border-ink-200 bg-white p-4 shadow-sm"
            >
              {showTeam && (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {p.team ? (
                    <Link
                      href={`/strategy/teams/${p.team.number}`}
                      className="inline-flex max-w-full items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-inset ring-sky-200 wrap-anywhere hover:bg-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
                    >
                      {plannerPathWhose(p.team)}
                    </Link>
                  ) : (
                    <Badge tone="brand">Ours</Badge>
                  )}
                </div>
              )}
              <h3 id={nameId} className="text-base font-semibold text-ink-900 wrap-anywhere">
                {p.name}
              </h3>
              {p.notes && <p className="line-clamp-4 whitespace-pre-line text-sm text-ink-600 wrap-anywhere">{p.notes}</p>}
              <p className="text-xs text-ink-500 wrap-anywhere">
                {savedLine(p, now, timeZone)} · {formatFileSize(p.size)}
              </p>
              <div className="mt-auto flex flex-wrap items-start gap-2 pt-1">
                <a href={plannerOpenHref(p.id)} target="_blank" rel="noopener" className={buttonClasses("primary", "md", "px-3")}>
                  <ExternalLink className="size-4" aria-hidden />
                  Open in planner
                  <span className="sr-only">
                    {" "}
                    {p.name} (opens in a new tab)
                  </span>
                </a>
                <a href={plannerPathDownloadHref(p.id)} download className={buttonClasses("secondary", "md", "px-3")}>
                  <Download className="size-4" aria-hidden />
                  Download .pp
                  <span className="sr-only"> {p.name}</span>
                </a>
                {p.canEdit && (
                  <>
                    <ButtonLink href={editHref(p.id, from)} variant="ghost" className="px-3" aria-label={`Edit ${p.name}`}>
                      <Pencil className="size-4" aria-hidden />
                      Edit
                    </ButtonLink>
                    <ActionForm
                      action={deletePlannerPathAction}
                      fields={{ pathId: p.id, ...removeFields }}
                      variant="ghost"
                      confirm={plannerPathRemoveQuestion(p.name)}
                      pendingText="Removing…"
                      aria-label={`Remove ${p.name}`}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      Remove
                    </ActionForm>
                  </>
                )}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
