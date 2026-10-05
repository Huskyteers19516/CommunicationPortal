import "server-only";
// The team website's sponsors (GET /api/public/sponsors, no sign-in) and their logos
// (GET /api/public/sponsors/logos/[id]). Only sponsors that are Accepted or Finished with "Thank them on the team
// website" on, and only while the owner hasn't turned sponsors off (Admin → Team website). Each answer is a
// sponsor's public name, website homepage, years, and logo — never amounts, what we asked for, contacts, the person on
// it, notes, stages, or files. See "Public API for the team website" in docs/CONVENTIONS.md.
import type { Prisma } from "@/generated/prisma/client";
import {
  PUBLIC_SPONSOR_STAGES,
  PUBLIC_SPONSORS_ROW_CAP,
  pickPublicSponsorName,
  type PublicSponsor,
  type PublicSponsorsAnswer,
  publicSponsorKey,
  publicSponsorLogoPath,
  publicSponsorUrl,
  sponsorPublicName,
  sponsorPublicYear,
} from "@/lib/public-sponsors";
import { type Db, prisma } from "../db";
import { STORED_FILE_SELECT, type StoredFileRow } from "../files/respond";
import { getPublicProgressConfig } from "./public-progress";

/** The sponsors the website may show (whether the owner turned sponsors off is checked separately). */
export const publicSponsorsWhere = {
  stage: { in: [...PUBLIC_SPONSOR_STAGES] },
  showOnWebsite: true,
} satisfies Prisma.SponsorshipWhereInput;

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

interface Row {
  name: string;
  /** Newest first: its year, then when it was added. */
  rank: [number, number];
  url: string | null;
}

interface Group {
  rows: Row[];
  years: Set<number>;
  logo: { id: string; createdAt: number } | null;
}

const byNewest = (a: Row, b: Row) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1];

/**
 * The public sponsors, grouped as the website shows them — whether or not the owner has sponsors turned off (the
 * answer checks that; Admin → Team website counts these before turning it on).
 */
export async function listPublicSponsors(db: Db, teamTimezone: string): Promise<PublicSponsor[]> {
  const rows = await db.sponsorship.findMany({
    where: publicSponsorsWhere,
    // Never more than this: no amounts, contacts, notes, owners, stages, or files.
    select: {
      name: true,
      publicName: true,
      website: true,
      acceptedOn: true,
      submittedOn: true,
      createdAt: true,
      logo: { select: { id: true, createdAt: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PUBLIC_SPONSORS_ROW_CAP,
  });

  const groups = new Map<string, Group>();
  for (const r of rows) {
    const name = sponsorPublicName(r);
    if (!name) continue;
    const key = publicSponsorKey(r);
    const year = sponsorPublicYear(r, teamTimezone);
    let g = groups.get(key);
    if (!g) {
      g = { rows: [], years: new Set(), logo: null };
      groups.set(key, g);
    }
    // Only the homepage, and only http(s) (rows can be written outside the app): never an application page's query.
    g.rows.push({ name, rank: [year, r.createdAt.getTime()], url: r.website ? publicSponsorUrl(r.website) : null });
    g.years.add(year);
    if (r.logo) {
      const at = r.logo.createdAt.getTime();
      if (!g.logo || at > g.logo.createdAt || (at === g.logo.createdAt && r.logo.id > g.logo.id)) g.logo = { id: r.logo.id, createdAt: at };
    }
  }

  const sponsors: PublicSponsor[] = [...groups.values()].map((g) => {
    const newest = g.rows.sort(byNewest);
    return {
      name: pickPublicSponsorName(newest.map((r) => r.name)),
      url: newest.find((r) => r.url)?.url ?? null,
      years: [...g.years].sort((a, b) => a - b),
      logo: g.logo ? publicSponsorLogoPath(g.logo.id) : null,
    };
  });
  const latest = (s: PublicSponsor) => s.years[s.years.length - 1];
  sponsors.sort((a, b) => latest(b) - latest(a) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sponsors;
}

/**
 * Everything the Sponsors page shows, or {enabled: false} while sponsors are turned off. Sponsors with the same public
 * name (ignoring case and spacing) are one entry: their years merged, the newest row's spelling of the name (unless
 * it's all lower-case and an older row's has capitals: pickPublicSponsorName) and the newest row's website homepage
 * (by year, then when it was added), and the newest logo. Latest year first, then by name.
 */
export async function getPublicSponsors(db: Db, options: { now: Date; teamTimezone: string }): Promise<PublicSponsorsAnswer> {
  const { settings } = await getPublicProgressConfig(db);
  if (!settings.showSponsors) return { enabled: false };
  return { enabled: true, updatedAt: options.now.toISOString(), sponsors: await listPublicSponsors(db, options.teamTimezone) };
}

/** Whether the team website's Sponsors page is on (Admin → Team website): the sponsor form says so when it's off. */
export async function publicSponsorsShown(db: Db = prisma): Promise<boolean> {
  return (await getPublicProgressConfig(db)).settings.showSponsors;
}

/** A public logo with its bytes and the public name it's served under (publicSponsorLogoFilename). */
export interface PublicSponsorLogoFile extends StoredFileRow {
  publicName: string;
}

/**
 * A logo with its bytes, for GET /api/public/sponsors/logos/[id] — only while its sponsor is on the team website
 * (Accepted or Finished, "Thank them on the team website" on, sponsors not turned off). Null otherwise, so a logo of
 * a sponsor taken off the website (or not on it yet) looks the same as one that doesn't exist. One read, with the
 * check in its WHERE: the bytes are never read for a logo that isn't public.
 */
export async function getPublicSponsorLogo(db: Db, id: string): Promise<PublicSponsorLogoFile | null> {
  if (!id || id.length > 64) return null;
  const { settings } = await getPublicProgressConfig(db);
  if (!settings.showSponsors) return null;
  const logo = await db.sponsorshipLogo.findFirst({
    where: { id, sponsorship: publicSponsorsWhere },
    select: { ...STORED_FILE_SELECT, sponsorship: { select: { name: true, publicName: true } } },
  });
  if (!logo) return null;
  const { sponsorship, ...file } = logo;
  return { ...file, publicName: sponsorPublicName(sponsorship) };
}
