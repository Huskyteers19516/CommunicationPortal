import { CircleCheck } from "lucide-react";
import { creditBreakdown, metWeeklyTarget, type WeekCredit, weekProgressText } from "@/lib/attendance";
import { cn } from "@/lib/cn";

/**
 * "1⅔ of 2 this week" toward the weekly target: green with a check once it's met, plain until then. With
 * `breakdown`, a line under it says what it's made of ("1 regular · ½ Flex · ½ EC"); `lead` goes first (e.g.
 * "Regular counts as 1", right after checking in).
 */
export function WeekProgress({
  week,
  target,
  label = "this week",
  breakdown = false,
  lead,
  className,
}: {
  week: WeekCredit;
  target: number;
  label?: string;
  breakdown?: boolean;
  lead?: string;
  className?: string;
}) {
  const met = metWeeklyTarget(week.total, target);
  const parts = creditBreakdown(week);
  return (
    <div className={cn("rounded-lg px-3 py-2", met ? "bg-brand-50 text-brand-800" : "bg-ink-50 text-ink-800", className)}>
      {lead && <p className="text-sm font-medium">{lead}</p>}
      <p className="flex flex-wrap items-center gap-x-2">
        <span>
          <span className="font-display text-xl font-semibold tabular-nums">{weekProgressText(week.total, target)}</span>
          {label && ` ${label}`}
        </span>
        {met && (
          <span className="inline-flex items-center gap-1 text-sm font-medium">
            <CircleCheck className="size-4" aria-hidden />
            Goal met
          </span>
        )}
      </p>
      {breakdown && <p className="text-xs text-ink-600">{parts || "Nothing yet"}</p>}
    </div>
  );
}

/** A small "1⅔ of 2" next to a name (✓ once it's met); screen readers also hear "this week". */
export function WeekPill({ total, target, label = "this week" }: { total: number; target: number; label?: string }) {
  const met = metWeeklyTarget(total, target);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ring-1 ring-inset",
        met ? "bg-brand-50 text-brand-800 ring-brand-200" : "bg-ink-50 text-ink-600 ring-ink-200",
      )}
    >
      {weekProgressText(total, target)}
      <span className="sr-only"> {label}</span>
      {met && (
        <>
          <span aria-hidden> ✓</span>
          <span className="sr-only">, goal met</span>
        </>
      )}
    </span>
  );
}
