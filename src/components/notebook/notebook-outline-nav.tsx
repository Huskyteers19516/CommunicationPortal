import { ChevronDown, FileText } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { NOTEBOOK_DEFAULT_EMOJI } from "@/lib/notebook";
import type { NotebookOutlineItem } from "@/server/queries/notebook";

/**
 * The notebooks and their pages as a compact outline (the left column on a page, and the "All notebooks" menu on
 * phones). Each notebook folds up; the current page is marked.
 */
export function NotebookOutlineNav({
  notebooks,
  currentPageId,
  label = "Notebooks",
}: {
  notebooks: Pick<NotebookOutlineItem, "id" | "title" | "emoji" | "pages">[];
  currentPageId: string;
  label?: string;
}) {
  return (
    <nav aria-label={label}>
      <ul className="space-y-1">
        {notebooks.map((n) => {
          const holdsCurrent = n.pages.some((p) => p.id === currentPageId);
          return (
            <li key={n.id}>
              <details open={holdsCurrent || notebooks.length <= 4} className="group">
                <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm font-semibold text-ink-800 hover:bg-ink-100 [&::-webkit-details-marker]:hidden">
                  <span aria-hidden>{n.emoji || NOTEBOOK_DEFAULT_EMOJI}</span>
                  <span className="min-w-0 flex-1 wrap-anywhere">{n.title}</span>
                  <ChevronDown className="size-4 shrink-0 text-ink-400 transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                {n.pages.length === 0 ? (
                  <p className="py-1 pl-8 text-xs text-ink-500">No pages yet</p>
                ) : (
                  <ul className="mt-0.5 space-y-0.5 pl-4">
                    {n.pages.map((p) => {
                      const current = p.id === currentPageId;
                      return (
                        <li key={p.id}>
                          <Link
                            href={`/notebook/p/${encodeURIComponent(p.id)}`}
                            aria-current={current ? "page" : undefined}
                            className={cn(
                              "flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm",
                              current ? "bg-brand-50 font-semibold text-brand-800" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
                            )}
                          >
                            <FileText className={cn("size-4 shrink-0", current ? "text-brand-600" : "text-ink-400")} aria-hidden />
                            <span className="min-w-0 flex-1 wrap-anywhere">{p.title}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </details>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
