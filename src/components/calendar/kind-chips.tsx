import Link from "next/link";
import type { CalendarEventKind } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";
import { CALENDAR_EVENT_KIND_LABELS, CALENDAR_EVENT_KINDS } from "@/lib/constants";
import { KindDot } from "./kind-styles";

function chipClasses(active: boolean) {
  return cn(
    "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors",
    active ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 bg-white text-ink-600 hover:bg-ink-50 hover:text-ink-900",
  );
}

/**
 * URL-driven kind filter ("All kinds", "League meet", …), each chip with its color dot. Scrolls sideways inside
 * itself on phones (the page doesn't); wraps onto more rows from `sm` up, so every chip (and its focus ring) shows.
 */
export function KindChips({ active, hrefFor }: { active: CalendarEventKind | undefined; hrefFor: (kind: CalendarEventKind | undefined) => string }) {
  return (
    <nav aria-label="Filter by kind" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:overflow-visible sm:px-0">
      <ul className="flex gap-2 pb-1 sm:flex-wrap">
        <li>
          <Link href={hrefFor(undefined)} aria-current={!active ? "true" : undefined} className={chipClasses(!active)}>
            All kinds
          </Link>
        </li>
        {CALENDAR_EVENT_KINDS.map((kind) => (
          <li key={kind}>
            <Link href={hrefFor(kind)} aria-current={active === kind ? "true" : undefined} className={chipClasses(active === kind)}>
              <KindDot kind={kind} />
              {CALENDAR_EVENT_KIND_LABELS[kind]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
