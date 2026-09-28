import { Check } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";

export interface FilterChip {
  href: string;
  label: string;
  active: boolean;
}

const chipBase =
  "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors";

function chipClasses(active: boolean) {
  return cn(
    chipBase,
    active ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 bg-white text-ink-600 hover:bg-ink-50 hover:text-ink-900",
  );
}

/**
 * URL-driven single-choice filter (e.g. subteam). Scrolls sideways on small screens. The scroller keeps 4 px
 * of padding on every side (cancelled by negative margins, so it lays out as tall as a chip) so keyboard focus
 * rings aren't clipped.
 */
export function FilterChips({ label, chips, className }: { label: string; chips: FilterChip[]; className?: string }) {
  return (
    <nav aria-label={label} className={cn("-mx-4 -my-1 overflow-x-auto px-4 py-1 sm:-mx-1 sm:px-1", className)}>
      <div className="flex gap-2">
        {chips.map((c) => (
          <Link key={c.href} href={c.href} aria-current={c.active ? "true" : undefined} className={chipClasses(c.active)}>
            {c.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** URL-driven on/off filter chip (e.g. "Created by me"). */
export function ToggleChip({ href, label, active }: FilterChip) {
  return (
    <Link href={href} aria-current={active ? "true" : undefined} className={chipClasses(active)}>
      {active && <Check className="size-4" aria-hidden />}
      {label}
    </Link>
  );
}
