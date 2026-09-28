import { CalendarClock, CalendarHeart, Flag, Hammer, Handshake, type LucideIcon, Medal, Swords, Trophy, Users } from "lucide-react";
import type { CalendarEventKind } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";
import { CALENDAR_EVENT_KIND_LABELS, CALENDAR_EVENT_KINDS } from "@/lib/constants";

/**
 * Each kind's color (full class names, so Tailwind finds them): `dot` for dots and the legend, `chip` for the
 * month grid's bars and the list's date blocks, `badge` for the kind badge.
 */
export const CALENDAR_KIND_STYLES: Record<CalendarEventKind, { dot: string; chip: string; badge: string; block: string }> = {
  MEET: {
    dot: "bg-brand-600",
    chip: "bg-brand-100 text-brand-900 hover:bg-brand-200",
    badge: "bg-brand-50 text-brand-800 ring-brand-200",
    block: "bg-brand-50 text-brand-800",
  },
  ILT: {
    dot: "bg-violet-600",
    chip: "bg-violet-100 text-violet-900 hover:bg-violet-200",
    badge: "bg-violet-50 text-violet-800 ring-violet-200",
    block: "bg-violet-50 text-violet-800",
  },
  SCRIMMAGE: {
    dot: "bg-sky-600",
    chip: "bg-sky-100 text-sky-900 hover:bg-sky-200",
    badge: "bg-sky-50 text-sky-800 ring-sky-200",
    block: "bg-sky-50 text-sky-800",
  },
  COMPETITION: {
    dot: "bg-orange-600",
    chip: "bg-orange-100 text-orange-900 hover:bg-orange-200",
    badge: "bg-orange-50 text-orange-800 ring-orange-200",
    block: "bg-orange-50 text-orange-800",
  },
  MEETING: {
    dot: "bg-teal-600",
    chip: "bg-teal-100 text-teal-900 hover:bg-teal-200",
    badge: "bg-teal-50 text-teal-800 ring-teal-200",
    block: "bg-teal-50 text-teal-800",
  },
  OUTREACH: {
    dot: "bg-pink-600",
    chip: "bg-pink-100 text-pink-900 hover:bg-pink-200",
    badge: "bg-pink-50 text-pink-800 ring-pink-200",
    block: "bg-pink-50 text-pink-800",
  },
  TEAM: {
    dot: "bg-amber-500",
    chip: "bg-amber-100 text-amber-900 hover:bg-amber-200",
    badge: "bg-amber-50 text-amber-800 ring-amber-200",
    block: "bg-amber-50 text-amber-800",
  },
  DEADLINE: {
    dot: "bg-red-600",
    chip: "bg-red-100 text-red-900 hover:bg-red-200",
    badge: "bg-red-50 text-red-700 ring-red-200",
    block: "bg-red-50 text-red-700",
  },
  OTHER: {
    dot: "bg-ink-500",
    chip: "bg-ink-100 text-ink-800 hover:bg-ink-200",
    badge: "bg-ink-100 text-ink-700 ring-ink-200",
    block: "bg-ink-100 text-ink-700",
  },
};

/** Each kind's icon. No other kind or button uses the same one (CalendarPlus stays for the "Add …" buttons). */
export const CALENDAR_KIND_ICONS: Record<CalendarEventKind, LucideIcon> = {
  MEET: Flag,
  ILT: Trophy,
  SCRIMMAGE: Swords,
  COMPETITION: Medal,
  MEETING: Hammer,
  OUTREACH: Handshake,
  TEAM: Users,
  DEADLINE: CalendarClock,
  OTHER: CalendarHeart,
};

/** Examples shown under each kind in the form. */
export const CALENDAR_KIND_HINTS: Record<CalendarEventKind, string> = {
  MEET: "Official Biobuzz league meets",
  ILT: "The qualifying tournament",
  SCRIMMAGE: "Biobuzz league Saturdays",
  COMPETITION: "Qualifiers, regionals",
  MEETING: "Counts as a meeting day",
  OUTREACH: "Demos, STEM nights",
  TEAM: "Socials, team photos",
  DEADLINE: "Registrations, forms",
  OTHER: "Anything else",
};

/** A small colored dot for the kind (decorative: say the kind in words next to it). */
export function KindDot({ kind, className }: { kind: CalendarEventKind; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", CALENDAR_KIND_STYLES[kind].dot, className)} />;
}

export function CalendarKindBadge({ kind, className }: { kind: CalendarEventKind; className?: string }) {
  const Icon = CALENDAR_KIND_ICONS[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        CALENDAR_KIND_STYLES[kind].badge,
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {CALENDAR_EVENT_KIND_LABELS[kind]}
    </span>
  );
}

/** Which color is which kind. */
export function CalendarLegend({ className }: { className?: string }) {
  return (
    <div className={className}>
      <h3 className="sr-only">Colors</h3>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-600">
        {CALENDAR_EVENT_KINDS.map((kind) => (
          <li key={kind} className="inline-flex items-center gap-1.5">
            <KindDot kind={kind} />
            {CALENDAR_EVENT_KIND_LABELS[kind]}
          </li>
        ))}
      </ul>
    </div>
  );
}
