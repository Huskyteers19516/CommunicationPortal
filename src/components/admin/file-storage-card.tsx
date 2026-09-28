import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/files";
import type { FileStorageUsage } from "@/server/files/storage";

/**
 * How much of the team's file storage is used, and by what: uploads stop when it's full, so this says where
 * the space is going and who can free it (Resources, sponsor files, posters, notebook pictures, strategy files).
 */
export function FileStorageCard({ usage }: { usage: FileStorageUsage }) {
  const pct = (n: number) => (usage.max > 0 ? Math.min(100, (n / usage.max) * 100) : 0);
  const level = usage.used >= usage.max * 0.9 ? "high" : "ok";
  const parts = [
    {
      key: "resources",
      label: "Resources files",
      bytes: usage.resources,
      swatch: "bg-brand-500",
      note: (
        <>
          Admins can remove old ones in{" "}
          <Link href="/resources" className="text-brand-700 underline underline-offset-2 hover:text-brand-800">
            Resources
          </Link>
          .
        </>
      ),
    },
    {
      key: "sponsors",
      label: "Sponsor files",
      bytes: usage.sponsors,
      swatch: "bg-sky-500",
      note: "Forms attached to sponsors. The Business leader, captain, mentors, and teachers can remove them.",
    },
    {
      key: "posters",
      label: "Posters",
      bytes: usage.posters,
      swatch: "bg-amber-500",
      note: (
        <>
          Poster pictures and PDFs. Whoever added one, and everyone with admin access, can remove old ones in{" "}
          <Link href="/posters?view=past" className="text-brand-700 underline underline-offset-2 hover:text-brand-800">
            Posters
          </Link>
          .
        </>
      ),
    },
    {
      key: "notebook",
      label: "Notebook pictures",
      bytes: usage.notebook,
      swatch: "bg-violet-500",
      note: "Pictures on Team notebook entries. Whoever wrote the entry, and the notebook's leaders, can remove them.",
    },
    {
      key: "strategy",
      label: "Strategy files",
      bytes: usage.strategy,
      swatch: "bg-rose-500",
      note: "Path files, diagrams, and PDFs on the Strategy page. Whoever added them, and everyone with admin access, can remove them.",
    },
  ];

  return (
    <Card>
      <CardHeader
        title="File storage"
        description={`${formatFileSize(usage.used)} of ${formatFileSize(usage.max)} used. Uploads stop when it's full.`}
      />
      <div className="space-y-3 px-4 py-3 sm:px-5">
        {/* The numbers below say the same thing in words. */}
        <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-ink-100">
          {parts.map((p) => (
            <div key={p.key} className={p.swatch} style={{ width: `${pct(p.bytes)}%` }} />
          ))}
        </div>
        {level === "high" && <p className="text-sm font-medium text-amber-800">Almost full. Remove files you don&apos;t need.</p>}
        <ul className="space-y-2">
          {parts.map((p) => (
            <li key={p.key} className="flex items-start gap-2">
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", p.swatch)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-ink-900">{p.label}</span>
                  <span className="shrink-0 tabular-nums text-ink-700">{formatFileSize(p.bytes)}</span>
                </p>
                <p className="mt-0.5 text-xs text-ink-500">{p.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
