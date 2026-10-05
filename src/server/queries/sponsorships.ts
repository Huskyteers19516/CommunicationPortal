import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { SPONSORSHIP_STAGES } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import type { ExistingSponsor } from "@/lib/sponsorship-import";
import {
  OPEN_SPONSORSHIP_STAGES,
  type OwnerOption,
  SPONSORSHIP_CLOSING_DAYS,
  SPONSORSHIP_FILTERS,
  type SponsorshipFilter,
} from "@/lib/sponsorships";
import { isPublicSponsor, PUBLIC_SPONSORS_ROW_CAP, publicSponsorKey } from "@/lib/public-sponsors";
import { parseHttpUrl } from "@/lib/urls";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { STORED_FILE_SELECT } from "../files/respond";
import { canDeleteSponsorship, canDeleteSponsorshipFile, canUseSponsorships, ledSubteam } from "../permissions";
import { getPublicProgressConfig } from "./public-progress";
import { publicSponsorsWhere } from "./public-sponsors";
import { previewKind } from "../resources/serve";
import { loadExistingSponsors, SPONSORSHIP_INFO_KEY, sponsorshipPeopleWhere } from "../services/sponsorships";

/** Most sponsorships the page lists (a team has dozens, not thousands). */
const LIST_LIMIT = 500;

function allowed(actor: Actor): boolean {
  return actor.status === "ACTIVE" && canUseSponsorships(actor);
}

function dateOrNull(value: Date | null): DateOnly | null {
  return value ? dbToDateOnly(value) : null;
}

export interface SponsorshipItem {
  id: string;
  name: string;
  /** http(s) only ("" = none). */
  website: string;
  contactName: string;
  contactEmail: string;
  asking: string;
  amountReceived: number | null;
  stage: SponsorshipStage;
  owner: { id: string; name: string } | null;
  submittedOn: DateOnly | null;
  acceptedOn: DateOnly | null;
  closesOn: DateOnly | null;
  /** Files attached to it (forms, filled-out copies…). */
  fileCount: number;
  /** The viewer can remove it (whoever added it, the Business leader, all-scope staff). */
  canDelete: boolean;
  /** "Thank them on the team website" (shown there once it's Accepted or Finished). */
  showOnWebsite: boolean;
  /** "Name on the website" ("" = its name). */
  publicName: string;
  /** It has a logo for the team website. */
  hasLogo: boolean;
  /**
   * On the team website (Accepted / Finished, thanked there) without a logo — and no other public sponsor with the
   * same public name has one: the list's "Logo needed" badge (loadSponsorsNeedingLogo).
   */
  logoNeeded: boolean;
}

export interface SponsorshipSummary {
  /** Every sponsorship, whatever the filters. */
  total: number;
  /** Sum of amounts received, in dollars. */
  totalReceived: number;
  /** How many sponsorships got money. */
  paying: number;
  counts: Record<SponsorshipStage, number>;
  /** Still to do (Haven't started / Do soon / Needs work) and closing between today and 14 days from now (the "closing" filter). */
  closingSoon: number;
  /** Submitted, waiting to hear back. */
  waiting: number;
  /** On the team website without a logo (the "Logo needed" filter). */
  logoNeeded: number;
}

export interface SponsorshipList {
  items: SponsorshipItem[];
  summary: SponsorshipSummary;
  truncated: boolean;
  /** The viewer can remove at least one of the items shown ("Select" on the list). */
  canBulkRemove: boolean;
}

const itemSelect = {
  id: true,
  name: true,
  website: true,
  contactName: true,
  contactEmail: true,
  asking: true,
  amountReceived: true,
  stage: true,
  submittedOn: true,
  acceptedOn: true,
  closesOn: true,
  createdById: true,
  owner: { select: { id: true, name: true } },
  showOnWebsite: true,
  publicName: true,
  logo: { select: { id: true } },
  _count: { select: { files: true } },
} as const satisfies Prisma.SponsorshipSelect;

type ItemRow = Prisma.SponsorshipGetPayload<{ select: typeof itemSelect }>;

function toItem(r: ItemRow, actor: Actor, needingLogo: ReadonlySet<string>): SponsorshipItem {
  return {
    id: r.id,
    name: r.name,
    // Rows can be written outside the app: only ever link to http(s).
    website: r.website ? (parseHttpUrl(r.website) ?? "") : "",
    contactName: r.contactName,
    contactEmail: r.contactEmail,
    asking: r.asking,
    amountReceived: r.amountReceived,
    stage: r.stage,
    owner: r.owner,
    submittedOn: dateOrNull(r.submittedOn),
    acceptedOn: dateOrNull(r.acceptedOn),
    closesOn: dateOrNull(r.closesOn),
    fileCount: r._count.files,
    canDelete: canDeleteSponsorship(actor, r),
    showOnWebsite: r.showOnWebsite,
    publicName: r.publicName,
    hasLogo: !!r.logo,
    logoNeeded: needingLogo.has(r.id),
  };
}

/**
 * "Logo needed": sponsors on the team website (Accepted / Finished, thanked there) without a logo, unless another
 * public sponsor with the same public name has one (the website shows that one: the same sponsor in another year).
 * Read in full and worked out here, since the grouping ignores case and spacing (a team has dozens of sponsors).
 */
export async function loadSponsorsNeedingLogo(db: Db = prisma): Promise<{ id: string; ownerId: string | null }[]> {
  const rows = await db.sponsorship.findMany({
    where: publicSponsorsWhere,
    select: { id: true, name: true, publicName: true, ownerId: true, logo: { select: { id: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PUBLIC_SPONSORS_ROW_CAP,
  });
  const withLogo = new Set(rows.filter((r) => r.logo).map(publicSponsorKey));
  return rows.filter((r) => !r.logo && !withLogo.has(publicSponsorKey(r))).map((r) => ({ id: r.id, ownerId: r.ownerId }));
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Stage order (Haven't started → Finished), then soonest deadline (none last), then name. */
export function compareSponsorships(a: SponsorshipItem, b: SponsorshipItem): number {
  const stage = SPONSORSHIP_STAGES.indexOf(a.stage) - SPONSORSHIP_STAGES.indexOf(b.stage);
  if (stage !== 0) return stage;
  if (a.closesOn !== b.closesOn) {
    if (!a.closesOn) return 1;
    if (!b.closesOn) return -1;
    return a.closesOn < b.closesOn ? -1 : 1;
  }
  return collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
}

/** Soonest deadline first, then stage and name (the "Closing soon" list). */
export function compareByDeadline(a: SponsorshipItem, b: SponsorshipItem): number {
  if (a.closesOn !== b.closesOn) {
    if (!a.closesOn) return 1;
    if (!b.closesOn) return -1;
    return a.closesOn < b.closesOn ? -1 : 1;
  }
  return compareSponsorships(a, b);
}

/** Open stages with a deadline between today and SPONSORSHIP_CLOSING_DAYS from now. */
function closingSoonWhere(today: DateOnly): Prisma.SponsorshipWhereInput {
  return {
    stage: { in: [...OPEN_SPONSORSHIP_STAGES] },
    closesOn: { gte: dateOnlyToDb(today), lte: dateOnlyToDb(addDays(today, SPONSORSHIP_CLOSING_DAYS)) },
  };
}

/**
 * The Sponsorships page: sponsorships matching the filter ("todo" = Haven't started / Do soon /
 * Needs work; "closing" = those with a deadline in the next 2 weeks, soonest first; `mine` = the viewer
 * is the person on it), sorted by stage, deadline, and name, plus team-wide numbers for the stat cards.
 * Null for people who can't use Sponsorships.
 */
export async function listSponsorships(
  actor: Actor,
  opts: { filter: SponsorshipFilter; mine?: boolean; today: DateOnly },
  db: Db = prisma,
): Promise<SponsorshipList | null> {
  if (!allowed(actor)) return null;
  const filter = SPONSORSHIP_FILTERS[opts.filter];
  const needing = await loadSponsorsNeedingLogo(db);
  const needingIds = new Set(needing.map((n) => n.id));
  const where: Prisma.SponsorshipWhereInput = {
    ...(filter.logoNeeded
      ? { id: { in: [...needingIds] } }
      : filter.closing
        ? closingSoonWhere(opts.today)
        : filter.stages
          ? { stage: { in: [...filter.stages] } }
          : {}),
    ...(opts.mine ? { ownerId: actor.id } : {}),
  };
  const [rows, byStage, closingSoon, paying] = await Promise.all([
    db.sponsorship.findMany({
      where,
      select: itemSelect,
      orderBy: [{ stage: "asc" }, { closesOn: { sort: "asc", nulls: "last" } }, { name: "asc" }],
      take: LIST_LIMIT + 1,
    }),
    db.sponsorship.groupBy({
      by: ["stage"],
      _count: { _all: true },
      _sum: { amountReceived: true },
    }),
    db.sponsorship.count({ where: closingSoonWhere(opts.today) }),
    db.sponsorship.count({ where: { amountReceived: { gt: 0 } } }),
  ]);

  const counts = Object.fromEntries(SPONSORSHIP_STAGES.map((s) => [s, 0])) as Record<SponsorshipStage, number>;
  let totalReceived = 0;
  for (const g of byStage) {
    counts[g.stage] = g._count._all;
    totalReceived += g._sum.amountReceived ?? 0;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const items = rows
    .slice(0, LIST_LIMIT)
    .map((r) => toItem(r, actor, needingIds))
    .sort(filter.closing ? compareByDeadline : compareSponsorships);
  return {
    items,
    summary: { total, totalReceived, paying, counts, closingSoon, waiting: counts.SUBMITTED, logoNeeded: needingIds.size },
    truncated: rows.length > LIST_LIMIT,
    canBulkRemove: items.some((i) => i.canDelete),
  };
}

/** A file attached to a sponsor, for its page (never the bytes). */
export interface SponsorshipFileItem {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  /** Who uploaded it (null when their account is gone). */
  uploadedByName: string | null;
  createdAt: Date;
  canDelete: boolean;
  /** Opens it in the browser (PDFs, images, text); null for types that are only downloaded. */
  viewHref: string | null;
  downloadHref: string;
}

/** A sponsor's logo for the team website, for its page (never the bytes). */
export interface SponsorshipLogoItem {
  id: string;
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
  uploadedByName: string | null;
  createdAt: Date;
  /** Shown on the sponsor's page (signed in; works before the sponsor is public). */
  previewHref: string;
}

export interface SponsorshipDetail extends SponsorshipItem {
  notes: string;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Oldest first (the order they were added). */
  files: SponsorshipFileItem[];
  logo: SponsorshipLogoItem | null;
  /** No logo of its own, but the website shows the logo of another public sponsor with the same public name. */
  logoFromSameName: boolean;
}

/** The route that shows a sponsor's logo to people who can use Sponsorships (src/app/(app)/sponsors/logos/[id]/route.ts). */
export function sponsorshipLogoHref(id: string): string {
  return `/sponsors/logos/${encodeURIComponent(id)}`;
}

/** The route that sends a sponsor's file (src/app/(app)/sponsors/files/[id]/route.ts). */
export function sponsorshipFileHref(id: string, download = false): string {
  return `/sponsors/files/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}

/** One sponsorship for its edit page (with its files' details), or null (missing, or the viewer can't use Sponsorships). */
export async function getSponsorship(actor: Actor, id: string, db: Db = prisma): Promise<SponsorshipDetail | null> {
  if (!allowed(actor) || !id || id.length > 64) return null;
  const r = await db.sponsorship.findUnique({
    where: { id },
    select: {
      ...itemSelect,
      notes: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { name: true } },
      files: {
        // Never the bytes.
        select: { id: true, filename: true, size: true, contentType: true, createdAt: true, uploadedById: true, uploadedBy: { select: { name: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      logo: {
        // Never the bytes.
        select: { id: true, filename: true, size: true, width: true, height: true, createdAt: true, uploadedBy: { select: { name: true } } },
      },
    },
  });
  if (!r) return null;
  const needing = r.logo || !isPublicSponsor(r) ? [] : await loadSponsorsNeedingLogo(db);
  const logoNeeded = needing.some((n) => n.id === r.id);
  return {
    ...toItem(r, actor, new Set(logoNeeded ? [r.id] : [])),
    logoFromSameName: !r.logo && isPublicSponsor(r) && !logoNeeded,
    notes: r.notes,
    createdByName: r.createdBy?.name ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    files: r.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      size: f.size,
      contentType: f.contentType,
      uploadedByName: f.uploadedBy?.name ?? null,
      createdAt: f.createdAt,
      canDelete: canDeleteSponsorshipFile(actor, { uploadedById: f.uploadedById, sponsorship: { createdById: r.createdById } }),
      viewHref: previewKind(f.filename, f.contentType) === "other" ? null : sponsorshipFileHref(f.id),
      downloadHref: sponsorshipFileHref(f.id, true),
    })),
    logo: r.logo
      ? {
          id: r.logo.id,
          filename: r.logo.filename,
          size: r.logo.size,
          width: r.logo.width,
          height: r.logo.height,
          uploadedByName: r.logo.uploadedBy?.name ?? null,
          createdAt: r.logo.createdAt,
          previewHref: sponsorshipLogoHref(r.logo.id),
        }
      : null,
  };
}

/**
 * A sponsor's logo with its bytes, for the signed-in preview route. Null when it's missing or the viewer can't use
 * Sponsorships (including accounts that aren't active), so both look the same.
 */
export async function getSponsorshipLogo(actor: Actor, id: string, db: Db = prisma) {
  if (!allowed(actor) || !id || id.length > 64) return null;
  return db.sponsorshipLogo.findUnique({ where: { id }, select: STORED_FILE_SELECT });
}

/**
 * Today's "N sponsors need a logo for the team website": every one for the Business leader, the ones they're the person
 * on for everyone else who can use Sponsorships. 0 while the owner has turned the website's sponsors off, and for
 * everyone outside Sponsorships.
 */
export async function countSponsorsNeedingLogo(actor: Actor, db: Db = prisma): Promise<number> {
  if (!allowed(actor)) return 0;
  const { settings } = await getPublicProgressConfig(db);
  if (!settings.showSponsors) return 0;
  const needing = await loadSponsorsNeedingLogo(db);
  const everyone = ledSubteam(actor) === "BUSINESS";
  return everyone ? needing.length : needing.filter((n) => n.ownerId === actor.id).length;
}

/**
 * A sponsor's file with its bytes, for the file route. Null when it's missing or the viewer can't use
 * Sponsorships (including accounts that aren't active), so both look the same.
 */
export async function getSponsorshipFile(actor: Actor, id: string, db: Db = prisma) {
  if (!allowed(actor) || !id || id.length > 64) return null;
  return db.sponsorshipFile.findUnique({ where: { id }, select: STORED_FILE_SELECT });
}

/**
 * Whether a sponsor is still there (the list's "Sponsor added." note for one it doesn't show: not after it's
 * been removed). False for people who can't use Sponsorships.
 */
export async function sponsorshipExists(actor: Actor, id: string, db: Db = prisma): Promise<boolean> {
  if (!allowed(actor) || !id || id.length > 64) return false;
  return (await db.sponsorship.count({ where: { id } })) > 0;
}

export interface SponsorshipInfo {
  body: string;
  updatedByName: string | null;
  updatedAt: Date | null;
}

/** The "Info for applications" note ("" when nobody has written it yet), or null for people without access. */
export async function getSponsorshipInfo(actor: Actor, db: Db = prisma): Promise<SponsorshipInfo | null> {
  if (!allowed(actor)) return null;
  const note = await db.teamNote.findUnique({
    where: { key: SPONSORSHIP_INFO_KEY },
    select: { body: true, updatedAt: true, updatedBy: { select: { name: true } } },
  });
  return { body: note?.body ?? "", updatedByName: note?.updatedBy?.name ?? null, updatedAt: note?.updatedAt ?? null };
}

export interface OwnerOptionGroups {
  business: OwnerOption[];
  /** Leaders of other subteams, the captain, mentors, teachers, owners. */
  staff: OwnerOption[];
}

/** Who can be the person on a sponsorship (ACTIVE and able to use Sponsorships): the Business team first, then staff. */
export async function getSponsorshipOwnerOptions(actor: Actor, db: Db = prisma): Promise<OwnerOptionGroups> {
  if (!allowed(actor)) return { business: [], staff: [] };
  const people = await db.user.findMany({
    where: sponsorshipPeopleWhere,
    select: { id: true, name: true, role: true, subteam: true, isAdmin: true },
    orderBy: { name: "asc" },
    take: 500,
  });
  const eligible = people.filter((p) => canUseSponsorships(p));
  const option = (p: (typeof people)[number]): OwnerOption => ({ id: p.id, name: p.name });
  return {
    business: eligible.filter((p) => p.subteam === "BUSINESS").map(option),
    staff: eligible.filter((p) => p.subteam !== "BUSINESS").map(option),
  };
}

/** What the import page's preview needs: the people to match names against, and the sponsors already here. */
export async function getSponsorshipImportContext(
  actor: Actor,
  db: Db = prisma,
): Promise<{ owners: OwnerOption[]; existing: ExistingSponsor[] } | null> {
  if (!allowed(actor)) return null;
  const [groups, existing] = await Promise.all([getSponsorshipOwnerOptions(actor, db), loadExistingSponsors(db)]);
  return { owners: [...groups.business, ...groups.staff], existing };
}
