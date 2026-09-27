import { Cog, Drill, type LucideIcon, Printer, Scissors, Wrench, Zap } from "lucide-react";
import type { PartProcess, Subteam } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";
import { PART_PROCESS_LABELS, SUBTEAM_LABELS } from "@/lib/constants";
import { type DateOnly, daysBetween, formatDateOnly, relativeDueLabel } from "@/lib/dates";
import { Badge, type BadgeTone } from "../ui/badge";

export const PART_PROCESS_ICONS: Record<PartProcess, LucideIcon> = {
  PRINT_3D: Printer,
  LASER_CUT: Zap,
  CNC: Cog,
  CUT: Scissors,
  MACHINE: Drill,
  OTHER: Wrench,
};

const processTone: Record<PartProcess, BadgeTone> = {
  PRINT_3D: "blue",
  LASER_CUT: "purple",
  CNC: "yellow",
  CUT: "gray",
  MACHINE: "gray",
  OTHER: "gray",
};

/** "3D print" with a printer icon, etc. */
export function ProcessBadge({ process }: { process: PartProcess }) {
  const Icon = PART_PROCESS_ICONS[process];
  return (
    <Badge tone={processTone[process]}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {PART_PROCESS_LABELS[process]}
    </Badge>
  );
}

/** A badge whose text may be long (user-written): wraps instead of widening the page. */
function WrappingBadge({ label, children, className }: { label: string; children: string; className?: string }) {
  return (
    <Badge tone="gray" className={cn("max-w-full", className)}>
      <span className="text-ink-600">{label}</span>
      <span className="min-w-0 whitespace-normal wrap-anywhere">{children}</span>
    </Badge>
  );
}

export function MaterialBadge({ material }: { material: string }) {
  if (!material) return null;
  return <WrappingBadge label="Material:">{material}</WrappingBadge>;
}

/** "For: Intake" (a Build category), "For: Vision · Software", "For: Events · Whole team". */
export function ForBadge({ category }: { category: { name: string; subteam: Subteam | null } | null }) {
  if (!category) return null;
  const where = category.subteam === "BUILD" ? "" : ` · ${category.subteam ? SUBTEAM_LABELS[category.subteam] : "Whole team"}`;
  return <WrappingBadge label="For:">{`${category.name}${where}`}</WrappingBadge>;
}

/** "Needed today" / "Needed in 3 days" / "Needed by Mon, Oct 5"; red "Late · needed 2 days ago" once past. */
export function NeededByBadge({ neededBy, today }: { neededBy: DateOnly | null; today: DateOnly }) {
  if (!neededBy) return null;
  const diff = daysBetween(today, neededBy);
  const label = relativeDueLabel(neededBy, today);
  if (diff < 0) {
    const when = diff === -1 ? "yesterday" : diff > -7 ? label : `on ${formatDateOnly(neededBy, today)}`;
    return <Badge tone="red">Late · needed {when}</Badge>;
  }
  if (diff === 0) return <Badge tone="brand">Needed today</Badge>;
  if (diff === 1) return <Badge tone="gray">Needed tomorrow</Badge>;
  if (diff < 7) return <Badge tone="gray">Needed in {diff} days</Badge>;
  return <Badge tone="gray">Needed by {formatDateOnly(neededBy, today)}</Badge>;
}
