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
import { parseHttpUrl } from "@/lib/urls";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { STORED_FILE_SELECT } from "../files/respond";
import { canDeleteSponsorship, canDeleteSponsorshipFile, canUseSponsorships } from "../permissions";
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
  _count: { select: { files: true } },
} as const satisfies Prisma.SponsorshipSelect;

type ItemRow = Prisma.SponsorshipGetPayload<{ select: typeof itemSelect }>;

function toItem(r: ItemRow, actor: Actor): SponsorshipItem {
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
  };
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
  const where: Prisma.SponsorshipWhereInput = {
    ...(filter.closing ? closingSoonWhere(opts.today) : filter.stages ? { stage: { in: [...filter.stages] } } : {}),
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
    .map((r) => toItem(r, actor))
    .sort(filter.closing ? compareByDeadline : compareSponsorships);
  return {
    items,
    summary: { total, totalReceived, paying, counts, closingSoon, waiting: counts.SUBMITTED },
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

export interface SponsorshipDetail extends SponsorshipItem {
  notes: string;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Oldest first (the order they were added). */
  files: SponsorshipFileItem[];
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
    },
  });
  if (!r) return null;
  return {
    ...toItem(r, actor),
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
  };
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
