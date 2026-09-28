import { Download, ExternalLink, FileText, Paperclip, Route } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PEDRO_VISUALIZER_URL } from "@/lib/constants";
import { formatFileSize } from "@/lib/files";
import type { StrategyFileInfo } from "@/server/queries/strategy";

const hintLink = "font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800";

/** Where the Load hint sends people: the planner on the Strategy page, or (a strategy about another team) theirs. */
interface PlannerLink {
  href: string;
  /** "on the Strategy page" */
  where: string;
}

const STRATEGY_PAGE_PLANNER: PlannerLink = { href: "/strategy#planner", where: "on the Strategy page" };

function FileRow({ file, planner }: { file: StrategyFileInfo; planner: PlannerLink }) {
  const Icon = file.kind === "path" ? Route : file.kind === "pdf" ? FileText : Paperclip;
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      {file.kind === "image" && file.viewHref && (
        <a
          href={file.viewHref}
          target="_blank"
          rel="noopener"
          className="flex justify-center rounded-lg border border-ink-200 bg-ink-50 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; next/image can't fetch it */}
          <img
            src={file.viewHref}
            alt={file.filename}
            loading="lazy"
            decoding="async"
            className="h-auto max-h-[60dvh] w-auto max-w-full rounded-md object-contain"
          />
          <span className="sr-only"> (opens full size in a new tab)</span>
        </a>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {file.kind !== "image" && <Icon className="mt-0.5 size-5 shrink-0 text-brand-700" aria-hidden />}
          <div className="min-w-0">
            <p className="font-medium text-ink-900 wrap-anywhere">{file.filename}</p>
            <p className="mt-0.5 text-xs text-ink-500">
              {file.kind === "path" ? "Pedro Pathing path" : file.kind === "pdf" ? "PDF" : file.kind === "image" ? "Picture" : "File"} ·{" "}
              {formatFileSize(file.size)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2 sm:shrink-0 sm:justify-end">
          {file.kind === "pdf" && file.viewHref && (
            <a href={file.viewHref} target="_blank" rel="noopener" className={buttonClasses("secondary", "md", "px-3")}>
              <ExternalLink className="size-4" aria-hidden />
              Open PDF
              <span className="sr-only">
                {" "}
                {file.filename} (opens in a new tab)
              </span>
            </a>
          )}
          <a
            href={file.downloadHref}
            download
            className={buttonClasses(file.kind === "path" ? "primary" : "secondary", "md", "px-3")}
          >
            <Download className="size-4" aria-hidden />
            {file.kind === "path" ? "Download path" : "Download"}
            <span className="sr-only"> {file.filename}</span>
          </a>
        </div>
      </div>
      {file.kind === "path" && (
        <p className="text-xs text-ink-500">
          To open it: the planner{" "}
          <Link href={planner.href} className={hintLink}>
            {planner.where}
          </Link>{" "}
          (or{" "}
          <a href={PEDRO_VISUALIZER_URL} target="_blank" rel="noopener noreferrer" className={hintLink}>
            in a new tab
          </a>
          ) → Load (the ↑ arrow at the top) → pick this file.
        </p>
      )}
    </li>
  );
}

/**
 * A strategy's files: pictures shown right here, PDFs to open, .pp paths to download and load in the planner
 * (`planner`: where the hint sends people; default the Strategy page's).
 */
export function StrategyFiles({ files, planner = STRATEGY_PAGE_PLANNER }: { files: StrategyFileInfo[]; planner?: PlannerLink }) {
  return (
    <section aria-labelledby="strategy-files-title">
      <Card>
        <CardHeader title={<span id="strategy-files-title">Files</span>} />
        <ul className="divide-y divide-ink-100">
          {files.map((f) => (
            <FileRow key={f.id} file={f} planner={planner} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
