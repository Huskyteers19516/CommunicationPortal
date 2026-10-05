import { ChevronRight, ImageUp } from "lucide-react";
import Link from "next/link";

/**
 * Today page: sponsors thanked on the team website without a logo (every one for the Business leader, the ones
 * they're the person on for everyone else in Sponsorships). Goes to the "Logo needed" filter.
 */
export function SponsorLogosLink({ count, mine }: { count: number; mine: boolean }) {
  if (count <= 0) return null;
  return (
    <Link
      href={mine ? "/sponsors?filter=logo&mine=1" : "/sponsors?filter=logo"}
      className="flex min-h-12 items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 shadow-sm transition-colors hover:border-amber-300 hover:bg-amber-100"
    >
      <ImageUp className="size-5 shrink-0 text-amber-700" aria-hidden />
      <span className="flex-1">
        {count === 1 ? "1 sponsor needs a logo" : `${count} sponsors need a logo`} for the team website
      </span>
      <ChevronRight className="size-4 shrink-0 text-amber-800" aria-hidden />
    </Link>
  );
}
