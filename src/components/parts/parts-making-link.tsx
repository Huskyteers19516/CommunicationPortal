import { ChevronRight, Printer } from "lucide-react";
import Link from "next/link";
import { plural } from "@/components/checklist/format";

/** Today page: a shortcut to the parts the viewer grabbed and hasn't marked done yet. */
export function PartsMakingLink({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Link
      href="/parts?who=making"
      className="flex min-h-12 items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm font-medium text-brand-900 shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-100"
    >
      <Printer className="size-5 shrink-0 text-brand-600" aria-hidden />
      <span className="flex-1">You&apos;re making {plural(count, "part")}</span>
      <ChevronRight className="size-4 shrink-0 text-brand-700" aria-hidden />
    </Link>
  );
}
