import Link from "next/link";
import type { Subteam } from "@/generated/prisma/enums";
import { SUBTEAMS, SUBTEAM_LABELS } from "@/lib/constants";
import { cn } from "@/lib/cn";
import { LinkTabs } from "@/components/ui/link-tabs";
import type { ProgressRange } from "@/server/queries/progress";
import { RANGE_OPTIONS } from "./progress-links";

/** Today / This week / Last 30 days. `hrefFor` builds the URL for a range (keeping other filters). */
export function ProgressRangeTabs({
  range,
  hrefFor,
  className,
}: {
  range: ProgressRange;
  hrefFor: (range: ProgressRange) => string;
  className?: string;
}) {
  return (
    <LinkTabs
      className={className}
      tabs={RANGE_OPTIONS.map((o) => ({ href: hrefFor(o.value), label: o.label, active: o.value === range }))}
    />
  );
}

/** Pill links to filter by subteam (all-scope staff only). */
export function SubteamChips({
  subteam,
  hrefFor,
  className,
}: {
  subteam: Subteam | null;
  hrefFor: (subteam: Subteam | null) => string;
  className?: string;
}) {
  const options: { value: Subteam | null; label: string }[] = [
    { value: null, label: "Everyone" },
    ...SUBTEAMS.map((s) => ({ value: s, label: SUBTEAM_LABELS[s] })),
  ];
  return (
    <nav aria-label="Filter by subteam" className={cn("flex flex-wrap gap-2", className)}>
      {options.map((o) => {
        const active = o.value === subteam;
        return (
          <Link
            key={o.value ?? "all"}
            href={hrefFor(o.value)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-10 items-center rounded-full border px-4 text-sm font-medium transition-colors",
              active
                ? "border-brand-500 bg-brand-500 text-white shadow-sm"
                : "border-ink-200 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50",
            )}
          >
            {o.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Colour key for the stacked progress bars. */
export function ProgressLegend({ className }: { className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500", className)}>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-brand-500" aria-hidden />
        Approved
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-amber-400" aria-hidden />
        Waiting for review
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-ink-200" aria-hidden />
        To do / needs changes / closed
      </span>
    </p>
  );
}
