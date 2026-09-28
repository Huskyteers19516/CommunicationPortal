import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { formatStamp, formatStampDay, NOTEBOOK_TEAM_LINE, writtenByLine } from "@/lib/notebook";
import type { NotebookExport } from "@/server/queries/notebook";
import { NotebookText } from "./notebook-text";
import { PrintButton } from "./print-button";

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A notebook (or one page) laid out for paper: a title page, then each page starting on a new sheet, each entry with
 * its stamp, text, pictures (full width), and "Edited by … on …". The toolbar only shows on screen.
 */
export function NotebookPrintView({ data, timeZone, now, backHref }: { data: NotebookExport; timeZone: string; now: Date; backHref: string }) {
  const onePage = data.scope === "page" ? data.pages[0] : undefined;
  const entries = data.pages.reduce((n, p) => n + p.entries.length, 0);
  return (
    <main className="mx-auto min-h-screen max-w-3xl bg-white px-4 py-6 text-ink-900 sm:px-8 print:max-w-none print:p-0">
      <div className="mb-8 flex flex-wrap items-center gap-2 rounded-xl border border-ink-200 bg-ink-50 p-3 print:hidden">
        <PrintButton />
        <Link
          href={backHref}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to the notebook
        </Link>
        <p className="w-full text-xs text-ink-500">To get a PDF, pick “Save as PDF” as the printer.</p>
      </div>

      <section className="flex min-h-[50vh] flex-col justify-center break-after-page print:min-h-[9in]">
        <p className="text-sm font-semibold uppercase tracking-wider text-brand-700">{NOTEBOOK_TEAM_LINE}</p>
        <h1 className="mt-3 font-display text-4xl font-semibold uppercase tracking-wide wrap-anywhere">
          {data.notebook.emoji && <span aria-hidden>{data.notebook.emoji} </span>}
          {data.notebook.title}
        </h1>
        {onePage && <p className="mt-2 text-2xl font-semibold text-ink-700 wrap-anywhere">{onePage.title}</p>}
        {data.notebook.description && <p className="mt-4 text-base text-ink-600 wrap-anywhere">{data.notebook.description}</p>}
        <p className="mt-8 text-sm text-ink-500">
          Exported {formatStampDay(now, timeZone)}
          {" · "}
          {!onePage && `${plural(data.pages.length, "page", "pages")} · `}
          {plural(entries, "entry", "entries")}
        </p>
      </section>

      {data.pages.map((page) => (
        <section key={page.id} className="break-before-page pt-8 print:pt-0" aria-labelledby={`print-page-${page.id}`}>
          <h2 id={`print-page-${page.id}`} className="border-b-2 border-brand-600 pb-2 text-2xl font-bold wrap-anywhere">
            {page.title}
          </h2>
          {page.entries.length === 0 && <p className="mt-4 text-sm italic text-ink-500">No entries yet.</p>}
          {page.entries.map((entry) => (
            <article key={entry.id} className="mt-6">
              <h3 className="break-after-avoid text-lg font-semibold wrap-anywhere">
                {entry.title || formatStampDay(entry.createdAt, timeZone)}
              </h3>
              <p className="break-after-avoid text-sm italic text-ink-600">{writtenByLine(entry.authorName, entry.createdAt, timeZone)}</p>
              <NotebookText body={entry.body} className="mt-2 text-[15px] text-ink-900" />
              {entry.images.map((img) => (
                // eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; printed as is
                <img
                  key={img.id}
                  src={img.src}
                  alt={img.filename}
                  width={img.width ?? undefined}
                  height={img.height ?? undefined}
                  className="mt-3 h-auto max-h-[8in] w-auto max-w-full break-inside-avoid rounded border border-ink-200 print:rounded-none"
                />
              ))}
              {entry.lastEditedAt && (
                <p className="mt-2 text-xs italic text-ink-500">
                  Edited by {entry.lastEditedByName ?? "a former member"} on {formatStamp(entry.lastEditedAt, timeZone)}
                </p>
              )}
            </article>
          ))}
        </section>
      ))}
    </main>
  );
}
