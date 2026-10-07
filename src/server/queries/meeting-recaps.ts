import "server-only";
// Meeting recaps (read side). Everyone ACTIVE reads every recap and may listen to its recording while it's kept
// (3 days); people with admin access (canManageMeetingRecaps) also get what the edit form and the recorder need.
// Every read works out the recording's state for `now` (meetingAudioState): past its 3 days it's gone, whether or not
// its parts were deleted yet. Writes: src/server/services/meeting-recaps.ts.
import type { Prisma } from "@/generated/prisma/client";
import type { Role, Subteam } from "@/generated/prisma/enums";
import { dbToDateOnly, type DateOnly, todayInTimezone } from "@/lib/dates";
import { escapeLike } from "@/lib/search";
import { parseKeyPointLines } from "@/lib/meeting-recorder/transcript-format";
import {
  type MeetingAudioState,
  type MeetingCategoryOption,
  MEETING_RECAP_TODAY_HOURS,
  MEETING_RECAPS_PAGE_SIZE,
  type MeetingRecapFilters,
  type MeetingRecapFormValues,
  normalizeMeetingAudioType,
} from "@/lib/meeting-recaps";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { env } from "../env";
import { STORED_FILE_SELECT, type StoredFileRow } from "../files/respond";
import { canManageMeetingRecaps } from "../permissions";
import { fileResponseHeaders, type ServedFile } from "../resources/serve";

type Viewer = Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">;

/** Key points shown on a card of the list (and on Today). */
const PREVIEW_POINTS = 3;
/** Recaps on Today. */
export const TODAY_MEETING_RECAPS_MAX = 3;

const byName = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

function canManage(viewer: Viewer): boolean {
  return viewer.status === "ACTIVE" && canManageMeetingRecaps(viewer);
}

// ---------- the recording's state ----------

/** The recording columns of a recap, and its parts (id and size, in order). */
interface AudioColumns {
  audioType: string | null;
  audioParts: number;
  audioBytes: number;
  audioExpiresAt: Date | null;
  audioDeletedAt: Date | null;
}

/**
 * A recap's recording at `now` (see MeetingAudioState): none, deleted (past its 3 days, or deleted sooner — `early`),
 * still uploading (fewer parts than declared, or a different size), or ready (its part ids in order).
 */
export function meetingAudioState(recap: AudioColumns, parts: { id: string; size: number }[], now: Date): MeetingAudioState {
  const audioType = recap.audioType ? normalizeMeetingAudioType(recap.audioType) : null;
  if (recap.audioParts === 0 || !audioType || !recap.audioExpiresAt) return { state: "none" };
  const expiresAt = recap.audioExpiresAt;
  if (recap.audioDeletedAt || expiresAt.getTime() <= now.getTime()) {
    const early = !!recap.audioDeletedAt && recap.audioDeletedAt.getTime() < expiresAt.getTime();
    return { state: "deleted", early, at: (early ? recap.audioDeletedAt! : expiresAt).toISOString() };
  }
  const bytes = parts.reduce((sum, p) => sum + p.size, 0);
  if (parts.length < recap.audioParts || bytes !== recap.audioBytes) {
    return { state: "uploading", received: Math.min(parts.length, recap.audioParts), total: recap.audioParts, expiresAt: expiresAt.toISOString() };
  }
  return { state: "ready", partIds: parts.map((p) => p.id), audioType, audioBytes: recap.audioBytes, expiresAt: expiresAt.toISOString() };
}

const audioSelect = {
  audioType: true,
  audioParts: true,
  audioBytes: true,
  audioExpiresAt: true,
  audioDeletedAt: true,
  // Ids and sizes only — never the bytes.
  audio: { select: { id: true, size: true }, orderBy: { position: "asc" } },
} as const satisfies Prisma.MeetingRecapSelect;

const categoriesSelect = { categories: { select: { category: { select: { id: true, name: true } } } } } as const satisfies Prisma.MeetingRecapSelect;

function categoryOptions(rows: { category: MeetingCategoryOption }[]): MeetingCategoryOption[] {
  return rows.map((r) => ({ id: r.category.id, name: r.category.name })).sort((a, b) => byName.compare(a.name, b.name));
}

// ---------- the list ----------

export interface MeetingRecapCard {
  id: string;
  title: string;
  meetingDate: DateOnly;
  categories: MeetingCategoryOption[];
  /** The first few key points' text (without their times). */
  keyPointsPreview: string[];
  keyPointCount: number;
  durationSec: number | null;
  /** Null when that account was deleted. */
  createdBy: { id: string; name: string } | null;
  /** ISO. */
  createdAt: string;
  audio: MeetingAudioState;
}

export interface MeetingRecapList {
  items: MeetingRecapCard[];
  /** Recaps matching the filters (all pages). */
  total: number;
  page: number;
  pageCount: number;
  /** There's at least one recap (ignoring the filters) — tells "none yet" from "none match". */
  anyAtAll: boolean;
  /** Every category, alphabetically (the filter chips). */
  categories: MeetingCategoryOption[];
  /** The `?category=` being looked at, when it exists. */
  category: MeetingCategoryOption | null;
  /** The viewer records, writes, and edits recaps. */
  canManage: boolean;
}

const cardSelect = {
  id: true,
  title: true,
  meetingDate: true,
  keyPoints: true,
  durationSec: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  ...categoriesSelect,
  ...audioSelect,
} as const satisfies Prisma.MeetingRecapSelect;

type CardRow = Prisma.MeetingRecapGetPayload<{ select: typeof cardSelect }>;

function toCard(row: CardRow, now: Date): MeetingRecapCard {
  const points = parseKeyPointLines(row.keyPoints);
  return {
    id: row.id,
    title: row.title,
    meetingDate: dbToDateOnly(row.meetingDate),
    categories: categoryOptions(row.categories),
    keyPointsPreview: points.slice(0, PREVIEW_POINTS).map((p) => p.text),
    keyPointCount: points.length,
    durationSec: row.durationSec,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    audio: meetingAudioState(row, row.audio, now),
  };
}

const LIST_ORDER = [{ meetingDate: "desc" }, { createdAt: "desc" }, { id: "desc" }] satisfies Prisma.MeetingRecapOrderByWithRelationInput[];

/** The list's filters as a where-clause: one category, and words in the title, key points, or transcript. */
function filtersWhere(filters: MeetingRecapFilters): Prisma.MeetingRecapWhereInput {
  const and: Prisma.MeetingRecapWhereInput[] = [];
  if (filters.category) and.push({ categories: { some: { categoryId: filters.category } } });
  if (filters.q) {
    const q = escapeLike(filters.q);
    and.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { keyPoints: { contains: q, mode: "insensitive" } },
        { transcript: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

/** Every category, alphabetically. */
async function allCategories(db: Db): Promise<MeetingCategoryOption[]> {
  const rows = await db.meetingCategory.findMany({ select: { id: true, name: true } });
  return rows.sort((a, b) => byName.compare(a.name, b.name));
}

/**
 * One page of recaps, newest meeting first (then the newest saved), with the list's filters. Null for accounts that
 * aren't active.
 */
export async function listMeetingRecaps(
  viewer: Viewer,
  filters: MeetingRecapFilters = {},
  now: Date = new Date(),
  db: Db = prisma,
): Promise<MeetingRecapList | null> {
  if (viewer.status !== "ACTIVE") return null;
  const where = filtersWhere(filters);
  const filtered = !!(filters.category || filters.q);
  const [total, anyAtAll, categories] = await Promise.all([
    db.meetingRecap.count({ where }),
    // Unfiltered, the total says it.
    filtered ? db.meetingRecap.count({ take: 1 }).then((n) => n > 0) : Promise.resolve(false),
    allCategories(db),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / MEETING_RECAPS_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(filters.page ?? 1) || 1), pageCount);
  const rows =
    total === 0
      ? []
      : await db.meetingRecap.findMany({
          where,
          orderBy: LIST_ORDER,
          skip: (page - 1) * MEETING_RECAPS_PAGE_SIZE,
          take: MEETING_RECAPS_PAGE_SIZE,
          select: cardSelect,
        });
  return {
    items: rows.map((r) => toCard(r, now)),
    total,
    page,
    pageCount,
    anyAtAll: total > 0 || anyAtAll,
    categories,
    category: categories.find((c) => c.id === filters.category) ?? null,
    canManage: canManage(viewer),
  };
}

/** Today: recaps saved in the last MEETING_RECAP_TODAY_HOURS hours, newest first (up to `limit`). Empty for accounts that aren't active. */
export async function getRecentMeetingRecaps(
  viewer: Viewer,
  now: Date = new Date(),
  db: Db = prisma,
  limit = TODAY_MEETING_RECAPS_MAX,
): Promise<MeetingRecapCard[]> {
  if (viewer.status !== "ACTIVE") return [];
  const since = new Date(now.getTime() - MEETING_RECAP_TODAY_HOURS * 60 * 60 * 1000);
  const rows = await db.meetingRecap.findMany({
    where: { createdAt: { gt: since, lte: now } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(1, Math.trunc(limit) || 1),
    select: cardSelect,
  });
  return rows.map((r) => toCard(r, now));
}

// ---------- one recap ----------

/** Who saved or edited a recap, with what describeRole needs. */
export interface MeetingRecapPerson {
  id: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
  isAdmin: boolean;
}

export interface MeetingRecapDetail {
  id: string;
  title: string;
  meetingDate: DateOnly;
  categories: MeetingCategoryOption[];
  keyPoints: string;
  transcript: string;
  durationSec: number | null;
  /** Null when that account was deleted. */
  createdBy: MeetingRecapPerson | null;
  /** ISO. */
  createdAt: string;
  /** ISO; set when the title, date, categories, key points, or transcript changed after it was saved. */
  editedAt: string | null;
  editedBy: MeetingRecapPerson | null;
  /** The edit form's and Delete's `version` (updatedAt, ISO). */
  version: string;
  audio: MeetingAudioState;
  /** The viewer may edit or delete it, and delete its recording. */
  canManage: boolean;
}

const personSelect = { select: { id: true, name: true, role: true, subteam: true, isAdmin: true } } as const;

/** One recap (its page), or null when it doesn't exist or the viewer isn't active. */
export async function getMeetingRecap(viewer: Viewer, id: string, now: Date = new Date(), db: Db = prisma): Promise<MeetingRecapDetail | null> {
  if (viewer.status !== "ACTIVE" || !id || id.length > 64) return null;
  const row = await db.meetingRecap.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      meetingDate: true,
      keyPoints: true,
      transcript: true,
      durationSec: true,
      createdAt: true,
      editedAt: true,
      updatedAt: true,
      createdBy: personSelect,
      editedBy: personSelect,
      ...categoriesSelect,
      ...audioSelect,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    meetingDate: dbToDateOnly(row.meetingDate),
    categories: categoryOptions(row.categories),
    keyPoints: row.keyPoints,
    transcript: row.transcript,
    durationSec: row.durationSec,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    editedBy: row.editedAt ? row.editedBy : null,
    version: row.updatedAt.toISOString(),
    audio: meetingAudioState(row, row.audio, now),
    canManage: canManage(viewer),
  };
}

/** A recap as the edit form shows it (with its `version`), or null unless the viewer manages recaps. */
export async function getMeetingRecapFormValues(viewer: Viewer, id: string, db: Db = prisma): Promise<MeetingRecapFormValues | null> {
  if (!canManage(viewer) || !id || id.length > 64) return null;
  const row = await db.meetingRecap.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      meetingDate: true,
      keyPoints: true,
      transcript: true,
      durationSec: true,
      updatedAt: true,
      ...categoriesSelect,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    version: row.updatedAt.toISOString(),
    title: row.title,
    meetingDate: dbToDateOnly(row.meetingDate),
    categoryIds: categoryOptions(row.categories).map((c) => c.id),
    keyPoints: row.keyPoints,
    transcript: row.transcript,
    durationSec: row.durationSec,
  };
}

// ---------- categories ----------

export interface MeetingCategoryRow extends MeetingCategoryOption {
  /** Recaps that have it. */
  recapCount: number;
}

/** The team's meeting categories, alphabetically, with how many recaps have each. Empty for accounts that aren't active. */
export async function listMeetingCategories(viewer: Viewer, db: Db = prisma): Promise<MeetingCategoryRow[]> {
  if (viewer.status !== "ACTIVE") return [];
  const rows = await db.meetingCategory.findMany({ select: { id: true, name: true, _count: { select: { recaps: true } } } });
  return rows.map((r) => ({ id: r.id, name: r.name, recapCount: r._count.recaps })).sort((a, b) => byName.compare(a.name, b.name));
}

// ---------- the recorder ----------

export interface MeetingRecorderSetup {
  /** Every category, alphabetically. */
  categories: MeetingCategoryOption[];
  /** First names of everyone ACTIVE (unique, alphabetical): the key points name owners of to-dos ("To do (Alice): …"). */
  roster: string[];
  /** The team's today (the meeting date's default). */
  today: DateOnly;
}

/** What the recorder page needs, or null unless the viewer manages recaps. */
export async function getMeetingRecorderSetup(viewer: Viewer, now: Date = new Date(), db: Db = prisma): Promise<MeetingRecorderSetup | null> {
  if (!canManage(viewer)) return null;
  const [categories, people] = await Promise.all([
    allCategories(db),
    db.user.findMany({ where: { status: "ACTIVE" }, select: { name: true } }),
  ]);
  const roster = new Set<string>();
  for (const p of people) {
    const first = p.name.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'’-]/gu, "");
    if (first && first.length >= 2) roster.add(first);
  }
  return { categories, roster: [...roster].sort(byName.compare), today: todayInTimezone(env.teamTimezone, now) };
}

// ---------- a part of a recording ----------

/**
 * One part of a recording for its route (GET /meetings/audio/[id]): for every ACTIVE person, while the recording
 * isn't past its 3 days or deleted (then null, a 404 — even before the purge got to it).
 */
export async function getMeetingAudioPartFile(viewer: Viewer, id: string, db: Db = prisma, now: Date = new Date()): Promise<StoredFileRow | null> {
  if (viewer.status !== "ACTIVE" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return db.meetingAudioPart.findFirst({
    where: { id, recap: { audioDeletedAt: null, audioExpiresAt: { gt: now } } },
    select: STORED_FILE_SELECT,
  });
}

/**
 * Headers for a part of a recording: always an application/octet-stream download (the player fetches the parts and
 * joins them; a part alone isn't a playable file), never cached (it's deleted in 3 days), nosniff, the sandboxing CSP,
 * same-origin only.
 */
export function meetingAudioHeaders(file: ServedFile): Record<string, string> {
  return fileResponseHeaders(file, { download: true });
}
