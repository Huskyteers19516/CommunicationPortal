import { Image as ImageIcon, Link2, Paperclip, Route } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { timeAgo } from "@/lib/dates";
import type { StrategyCard } from "@/server/queries/strategy";
import { PinnedBadge, StrategyKindBadge } from "./kind-badge";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Indicator({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/**
 * The team's strategies as cards (one column on phones, two on wide screens): title (the link), kind, pinned,
 * who added it and when it last changed, the start of the description, and what's attached.
 */
export function StrategyList({ strategies, now, timeZone }: { strategies: StrategyCard[]; now: Date; timeZone: string }) {
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {strategies.map((s) => (
        <li key={s.id} className="min-w-0">
          <article className="relative flex h-full min-w-0 flex-col gap-2 rounded-xl border border-ink-200 bg-white p-4 shadow-sm transition-colors focus-within:border-brand-300 hover:border-brand-300">
            <div className="flex flex-wrap items-center gap-1.5">
              <StrategyKindBadge kind={s.kind} />
              {s.pinned && <PinnedBadge />}
            </div>
            <h3 className="text-base font-semibold text-ink-900 wrap-anywhere">
              {/* The whole card opens it (the link stretches over it); nothing else in the card is clickable. */}
              <Link
                href={`/strategy/${encodeURIComponent(s.id)}`}
                className="rounded after:absolute after:inset-0 after:rounded-xl hover:text-brand-800 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-brand-500/50"
              >
                {s.title}
              </Link>
            </h3>
            {s.descriptionPreview && <p className="line-clamp-3 text-sm text-ink-600 wrap-anywhere">{s.descriptionPreview}</p>}
            <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-ink-500">
              <span className="min-w-0 wrap-anywhere">
                {s.mine ? "You" : (s.createdByName ?? "A former member")} · updated {timeAgo(s.updatedAt, now, timeZone)}
              </span>
              {s.pathCount > 0 && (
                <Indicator icon={<Route className="size-3.5 shrink-0 text-brand-700" aria-hidden />}>
                  {plural(s.pathCount, "path", "paths")}
                </Indicator>
              )}
              {s.imageCount > 0 && (
                <Indicator icon={<ImageIcon className="size-3.5 shrink-0" aria-hidden />}>
                  {plural(s.imageCount, "picture", "pictures")}
                </Indicator>
              )}
              {s.otherFileCount > 0 && (
                <Indicator icon={<Paperclip className="size-3.5 shrink-0" aria-hidden />}>
                  {plural(s.otherFileCount, "file", "files")}
                </Indicator>
              )}
              {s.linkHost && <Indicator icon={<Link2 className="size-3.5 shrink-0" aria-hidden />}>{s.linkHost}</Indicator>}
            </div>
          </article>
        </li>
      ))}
    </ul>
  );
}
