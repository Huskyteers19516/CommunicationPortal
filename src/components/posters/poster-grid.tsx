import { FileText, Link2, Paperclip } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { type DateOnly, formatDateOnly } from "@/lib/dates";
import { posterWhen } from "@/lib/posters";
import type { PosterTile } from "@/server/queries/posters";

/**
 * The posters as a thumbnail grid: 2 columns on phones, 3 on tablets and laptops, 4 on wide screens. Pictures fill a
 * 3:4 frame (cropped, loaded lazily); PDFs and link-only posters get a tile saying what they are.
 */
export function PosterGrid({ posters, today }: { posters: PosterTile[]; today: DateOnly }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4">
      {posters.map((p) => (
        <li key={p.id} className="min-w-0">
          <PosterCard poster={p} today={today} />
        </li>
      ))}
    </ul>
  );
}

function PosterCard({ poster: p, today }: { poster: PosterTile; today: DateOnly }) {
  const when = posterWhen(p.event, p.eventDate ? formatDateOnly(p.eventDate, today) : null);
  return (
    <Link
      href={`/posters/${encodeURIComponent(p.id)}`}
      className="group block h-full overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm transition-colors hover:border-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-ink-100">
        <PosterThumb poster={p} />
      </div>
      <div className="min-w-0 p-2.5 sm:p-3">
        <p className="line-clamp-2 text-sm font-semibold text-ink-900 wrap-anywhere group-hover:text-brand-800">{p.title}</p>
        {when && <p className="mt-0.5 line-clamp-2 text-xs text-ink-500 wrap-anywhere">{when}</p>}
      </div>
    </Link>
  );
}

function Tile({ icon, label, detail, className }: { icon: ReactNode; label: string; detail?: string; className: string }) {
  return (
    <div className={cn("absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center", className)}>
      {icon}
      <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      {detail && <span className="max-w-full truncate text-xs opacity-80">{detail}</span>}
    </div>
  );
}

function PosterThumb({ poster: p }: { poster: PosterTile }) {
  if (p.kind === "image" && p.imageSrc) {
    // The title is right below, so the picture itself is decorative here.
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a private upload behind sign-in; next/image can't fetch it
      <img
        src={p.imageSrc}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
      />
    );
  }
  if (p.kind === "pdf") {
    return <Tile icon={<FileText className="size-10" aria-hidden />} label="PDF" className="bg-red-50 text-red-700" />;
  }
  if (p.kind === "file") {
    return <Tile icon={<Paperclip className="size-10" aria-hidden />} label="File" className="bg-ink-100 text-ink-600" />;
  }
  return (
    <Tile
      icon={<Link2 className="size-10" aria-hidden />}
      label="Link"
      detail={p.linkHost || undefined}
      className="bg-sky-50 text-sky-800"
    />
  );
}
