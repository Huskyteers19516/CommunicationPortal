import { Star } from "lucide-react";
import Link from "next/link";
import { WORKSHOP_KIND_LABELS } from "@/lib/workshop";
import type { WorkshopCard } from "@/server/queries/workshop";
import { WORKSHOP_KIND_ICONS } from "./kinds";
import { WorkshopStatusLine } from "./workshop-badges";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Workshop projects as a card grid: 2 columns on phones, 3 on tablets and laptops, 4 on wide screens. The cover photo
 * fills a 4:3 frame (cropped, loaded lazily); a project without photos gets a tile with its kind's icon.
 */
export function WorkshopGrid({ projects }: { projects: WorkshopCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4">
      {projects.map((p) => (
        <li key={p.id} className="min-w-0">
          <ProjectCard project={p} />
        </li>
      ))}
    </ul>
  );
}

function ProjectCard({ project: p }: { project: WorkshopCard }) {
  const KindIcon = WORKSHOP_KIND_ICONS[p.kind];
  const counts = [plural(p.photoCount, "photo", "photos"), p.fileCount > 0 && plural(p.fileCount, "file", "files")].filter(Boolean).join(" · ");
  return (
    <Link
      href={`/workshop/${encodeURIComponent(p.id)}`}
      className="group flex h-full flex-col overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm transition-colors hover:border-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-ink-100">
        {p.cover ? (
          // The title is right below, so the photo itself is decorative here.
          // eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; next/image can't fetch it
          <img
            src={p.cover.src}
            alt=""
            width={p.cover.width}
            height={p.cover.height}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-3 text-center text-ink-500">
            <KindIcon className="size-9" aria-hidden />
            <span className="text-xs font-medium">No photo yet</span>
          </div>
        )}
        {p.featured && (
          <span className="absolute left-2 top-2 inline-flex size-7 items-center justify-center rounded-full bg-white/95 text-amber-500 shadow-sm">
            <Star className="size-4 fill-current" aria-hidden />
            <span className="sr-only">Featured</span>
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 p-2.5 sm:p-3">
        <p className="line-clamp-2 text-sm font-semibold text-ink-900 wrap-anywhere group-hover:text-brand-800">{p.title}</p>
        <p className="flex items-center gap-1 text-xs text-ink-500">
          <KindIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{WORKSHOP_KIND_LABELS[p.kind]}</span>
        </p>
        {p.designers.length > 0 && <p className="line-clamp-1 text-xs text-ink-600 wrap-anywhere">{p.designers.join(", ")}</p>}
        <p className="text-xs text-ink-500">{counts}</p>
        {p.status !== "APPROVED" && <WorkshopStatusLine status={p.status} className="mt-1" />}
      </div>
    </Link>
  );
}
