import { Download, Eye, ExternalLink, Paperclip, Pencil, Pin } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/files";
import type { ResourceItem } from "@/server/queries/resources";
import { ResourceIcon } from "./resource-icon";

/** Title link: external links open in a new tab without referrer; uploaded files open their page. */
export function ResourceTitle({ item }: { item: Pick<ResourceItem, "id" | "kind" | "title" | "href"> }) {
  const className = "group inline-flex min-w-0 items-center gap-1.5 font-semibold text-ink-900 hover:text-brand-700";
  if (item.kind === "file") {
    return (
      <Link href={`/resources/${item.id}`} className={className}>
        <span className="wrap-anywhere">{item.title}</span>
      </Link>
    );
  }
  return (
    <a href={item.href} target="_blank" rel="noopener noreferrer" className={className}>
      <span className="wrap-anywhere">{item.title}</span>
      <ExternalLink className="size-3.5 shrink-0 text-ink-400 group-hover:text-brand-600" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** "docs.example.com" for links; a paperclip, "TeleOpMain.java · 3.2 KB" for files. */
export function ResourceSource({ item }: { item: Pick<ResourceItem, "kind" | "host" | "file"> }) {
  if (item.kind === "file" && item.file) {
    return (
      <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-ink-500">
        <Paperclip className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-mono" title={item.file.filename}>
          {item.file.filename}
        </span>
        <span className="shrink-0">· {formatFileSize(item.file.size)}</span>
      </p>
    );
  }
  return item.host ? <p className="mt-0.5 truncate text-xs text-ink-500" title={item.host}>{item.host}</p> : null;
}

/** View + Download buttons for an uploaded file. */
export function ResourceFileButtons({ item }: { item: Pick<ResourceItem, "id" | "title"> }) {
  return (
    <>
      <Link href={`/resources/${item.id}`} className={buttonClasses("secondary", "md")} aria-label={`View ${item.title}`}>
        <Eye className="size-4" aria-hidden />
        View
      </Link>
      <a href={`/resources/files/${encodeURIComponent(item.id)}?download=1`} className={buttonClasses("secondary", "md")} aria-label={`Download ${item.title}`}>
        <Download className="size-4" aria-hidden />
        Download
      </a>
    </>
  );
}

/** One approved resource on the Resources page. */
export function ResourceCard({ item, canManage }: { item: ResourceItem; canManage: boolean }) {
  const isFile = item.kind === "file";
  return (
    <li className={cn("rounded-xl border bg-white p-4 shadow-sm", item.pinned ? "border-brand-200" : "border-ink-200")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
          <ResourceIcon type={item.type} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <ResourceTitle item={item} />
            <div className="flex shrink-0 items-center gap-2">
              {item.pinned && (
                <Badge tone="brand">
                  <Pin className="size-3" aria-hidden />
                  Pinned
                </Badge>
              )}
              <Badge tone="gray">{RESOURCE_TYPE_LABELS[item.type]}</Badge>
            </div>
          </div>
          <ResourceSource item={item} />
          {item.description && <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm text-ink-700">{item.description}</p>}
          {item.links.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2" aria-label={`Quick links for ${item.title}`}>
              {item.links.map((l, i) => (
                <li key={i} className="min-w-0 max-w-full">
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-10 max-w-full items-center rounded-full border border-ink-200 bg-ink-50 wrap-anywhere px-3.5 py-1.5 text-sm font-medium text-ink-800 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {(isFile || canManage) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {isFile && <ResourceFileButtons item={item} />}
              {canManage && (
                <Link
                  href={`/resources/${item.id}/edit`}
                  className={buttonClasses("ghost", "md", isFile ? "text-ink-600" : "-ml-4 text-ink-600")}
                  aria-label={`Edit ${item.title}`}
                >
                  <Pencil className="size-3.5" aria-hidden />
                  Edit
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
