import { Cloud, Database } from "lucide-react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/files";
import type { FileStorageOverview, FileStorageOwnerView } from "@/server/queries/files";
import { FileStorageTools } from "./file-storage-tools";

const files = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "file" : "files"}`;

/** Everyone who sees the card: where new files go, and how many files are in each place. */
function LocationSection({ overview }: { overview: FileStorageOverview }) {
  const inR2 = overview.location === "r2";
  const Icon = inR2 ? Cloud : Database;
  return (
    <div className="space-y-3 border-t border-ink-100 px-4 py-3 sm:px-5">
      <p className="flex items-start gap-2 text-sm text-ink-800">
        <Icon className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
        <span>
          New files go to <span className="font-semibold">{inR2 ? "Cloudflare R2" : "the database"}</span>
          {inR2 ? "." : " (Neon Postgres)."}
        </span>
      </p>
      <ul className="space-y-1 text-xs text-ink-600">
        <li className="flex justify-between gap-3">
          <span>In Cloudflare R2</span>
          <span className="tabular-nums">
            {files(overview.inObjectStorage.count)} · {formatFileSize(overview.inObjectStorage.bytes)}
          </span>
        </li>
        <li className="flex justify-between gap-3">
          <span>In the database</span>
          <span className="tabular-nums">
            {files(overview.inDatabase.count)} · {formatFileSize(overview.inDatabase.bytes)}
          </span>
        </li>
      </ul>
      {overview.owner ? (
        <OwnerSection overview={overview} owner={overview.owner} />
      ) : (
        <p className="text-xs text-ink-500">
          Only owners can set up Cloudflare R2 and move files there (it needs the team&apos;s Cloudflare and Vercel
          accounts). Ask an owner if the storage is getting full.
        </p>
      )}
    </div>
  );
}

/** Owners only: the settings' state and the tools. */
function OwnerSection({ overview, owner }: { overview: FileStorageOverview; owner: FileStorageOwnerView }) {
  const inR2 = overview.location === "r2";
  const inObjectStorage = overview.inObjectStorage.count;
  const waiting = owner.waitingDeletions + owner.stuckDeletions;
  return (
    <>
      {owner.r2Problem && <Alert tone="warning">{owner.r2Problem}</Alert>}
      {!inR2 && inObjectStorage > 0 && (
        <Alert tone="error">
          {`${files(inObjectStorage)} ${inObjectStorage === 1 ? "is" : "are"} in Cloudflare R2, but R2 isn't set up on this site, so ${inObjectStorage === 1 ? "it" : "they"} can't be opened. Put the R2 settings back in Vercel and redeploy.`}
        </Alert>
      )}
      {!inR2 && owner.r2 === "off" && (
        <p className="text-xs text-ink-500">
          Need more room? Set up Cloudflare R2 (free up to 10 GB): see “More room for files” in the README (Put it online, step 9).
        </p>
      )}
      {inR2 && owner.stuckDeletions > 0 && (
        <p className="text-xs text-amber-800">
          {`${files(owner.stuckDeletions)} couldn't be deleted from Cloudflare R2 after many tries, so ${owner.stuckDeletions === 1 ? "it's" : "they're"} only tried again when you press Clean up.`}
        </p>
      )}
      {inR2 && (
        <FileStorageTools
          canMove={overview.inDatabase.count > 0}
          moveLabel={`Move ${files(overview.inDatabase.count)} (${formatFileSize(overview.inDatabase.bytes)}) to R2`}
          waiting={waiting}
        />
      )}
    </>
  );
}

/**
 * How much of the team's file storage is used, and by what: uploads stop when it's full, so this says where
 * the space is going and who can free it (Resources, sponsor files, posters, notebook pictures, strategy files,
 * sponsor logos, Workshop photos and design files).
 * Everyone who sees it also sees where new files go; owners also get the settings' state and the Cloudflare R2 tools
 * (`overview.owner`).
 */
export function FileStorageCard({ overview }: { overview: FileStorageOverview }) {
  const { usage } = overview;
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
    {
      key: "logos",
      label: "Sponsor logos",
      bytes: usage.logos,
      swatch: "bg-teal-500",
      note: "Brand logos for the team website's Sponsors page (one per sponsor). The Business team and leaders can replace or remove them on each sponsor's page.",
    },
    {
      key: "workshop",
      label: "Workshop",
      bytes: usage.workshop,
      swatch: "bg-indigo-500",
      note: (
        <>
          Photos and design files in the{" "}
          <Link href="/workshop" className="text-brand-700 underline underline-offset-2 hover:text-brand-800">
            Workshop
          </Link>
          . Whoever added the project, the people credited on it, and everyone with admin access can remove them.
        </>
      ),
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
      <LocationSection overview={overview} />
    </Card>
  );
}
