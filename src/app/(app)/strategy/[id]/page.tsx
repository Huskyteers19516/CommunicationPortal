import { Link2, Pencil, Trash2, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { PinnedBadge, StrategyKindBadge } from "@/components/strategy/kind-badge";
import { PinButton } from "@/components/strategy/pin-button";
import { StrategyFiles } from "@/components/strategy/strategy-files";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { RichText } from "@/components/ui/rich-text";
import { formatDateTime } from "@/lib/dates";
import { strategyRemoveQuestion } from "@/lib/strategy";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getStrategyDetail } from "@/server/queries/strategy";
import { deleteStrategyAction } from "../actions";

// Shared by generateMetadata and the page so the strategy loads once per request.
const loadStrategy = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return getStrategyDetail(actor, id);
});

export async function generateMetadata({ params }: PageProps<"/strategy/[id]">): Promise<Metadata> {
  const { id } = await params;
  const strategy = await loadStrategy(id);
  return { title: strategy?.title ?? "Strategy" };
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function StrategyDetailPage({ params, searchParams }: PageProps<"/strategy/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const s = await loadStrategy(id);
  if (!s) notFound();
  const timeZone = env.teamTimezone;
  const added = first(sp.added) === "1";
  const saved = first(sp.saved) === "1";
  const edited = s.updatedAt.getTime() - s.createdAt.getTime() > 60_000;

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 space-y-5">
      <div>
        {s.team ? (
          <BackLink href={`/strategy/teams/${s.team.number}`}>
            {/* A fixed cap: the back link sizes to its text, so a long name would otherwise widen the page. */}
            <span className="max-w-56 truncate sm:max-w-lg">
              {s.team.number} · {s.team.name}
            </span>
          </BackLink>
        ) : (
          <BackLink href="/strategy#strategies">Strategy</BackLink>
        )}
        {/* Takes focus: after Add or Save the page would otherwise open where the form was scrolled to. */}
        {(added || saved) && (
          <div className="mb-4">
            <FocusAlert tone="success">{added ? "Strategy added. The whole team can see it now." : "Changes saved."}</FocusAlert>
          </div>
        )}
        <header className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <StrategyKindBadge kind={s.kind} />
            {s.pinned && <PinnedBadge />}
          </div>
          {s.team && (
            <p className="mb-1 flex min-w-0 items-center gap-1.5 text-sm font-medium text-ink-700">
              <UsersRound className="size-4 shrink-0 text-brand-700" aria-hidden />
              <span className="min-w-0 wrap-anywhere">
                About{" "}
                <Link href={`/strategy/teams/${s.team.number}`} className="text-brand-700 underline underline-offset-2 hover:text-brand-800">
                  {s.team.number} · {s.team.name}
                </Link>
              </span>
            </p>
          )}
          <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink-900 wrap-anywhere sm:text-3xl">{s.title}</h1>
          <p className="mt-1 text-sm text-ink-500 wrap-anywhere">
            Added by <span className="font-medium text-ink-700">{s.createdByName ?? "a former member"}</span> ·{" "}
            {formatDateTime(s.createdAt, timeZone)}
            {edited && <> · updated {formatDateTime(s.updatedAt, timeZone)}</>}
          </p>
        </header>
      </div>

      {s.link && (
        <div className="space-y-1">
          {/* No host on the button (it doesn't wrap, so a long one would widen the page): the full link is just below. */}
          <a href={s.link} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "md")}>
            <Link2 className="size-4" aria-hidden />
            Open link
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <p className="text-xs text-ink-500 wrap-anywhere">{s.link}</p>
        </div>
      )}

      {s.description ? (
        <RichText text={s.description} className="text-sm text-ink-800 wrap-anywhere sm:text-base" />
      ) : (
        <p className="text-sm text-ink-500">No description.</p>
      )}

      {s.files.length > 0 && (
        <StrategyFiles
          files={s.files}
          planner={s.team ? { href: `/strategy/teams/${s.team.number}#trace`, where: "on their team page" } : undefined}
        />
      )}

      {(s.canEdit || s.canPin) && (
        <div className="flex flex-wrap items-start gap-2 border-t border-ink-200 pt-4">
          {s.canEdit && (
            <ButtonLink href={`/strategy/${s.id}/edit`} variant="secondary" aria-label={`Edit ${s.title}`}>
              <Pencil className="size-4" aria-hidden />
              Edit
            </ButtonLink>
          )}
          {s.canPin && <PinButton strategyId={s.id} title={s.title} pinned={s.pinned} />}
          {s.canEdit && (
            <ActionForm
              action={deleteStrategyAction}
              fields={{ strategyId: s.id }}
              variant="ghost"
              confirm={strategyRemoveQuestion(s.title, s.files.length)}
              pendingText="Removing…"
              aria-label={`Remove ${s.title}`}
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
