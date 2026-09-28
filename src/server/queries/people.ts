import "server-only";
// Team members (/people): everyone on the team, for every ACTIVE person to see — who's who and how to email them.
// This is the PUBLIC view of an account, so it only ever reads ACTIVE accounts and only the fields below: never
// the password hash, sessions, approval details, email preferences, or sign-ups waiting for approval, turned-down
// or disabled accounts (those stay in Admin → People, `queries/admin.ts`).

import type { Prisma } from "@/generated/prisma/client";
import { Role, Subteam } from "@/generated/prisma/enums";
import { ROLES, SUBTEAMS, describeRole } from "@/lib/constants";
import { cleanSearchText, escapeLike } from "@/lib/search";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { ForbiddenError } from "../errors";
import { canManageAccount } from "../permissions";

/** The team is ~40 people; the list stops here so a page can never load an unbounded number of accounts. */
export const TEAM_MEMBERS_MAX = 300;
export const TEAM_MEMBER_SEARCH_MAX = 100;
/** Shorter searches ("ma") only look at names and emails, so they don't also pull in every "Member" or "Mentor". */
export const POSITION_SEARCH_MIN = 3;

export interface TeamMemberFilters {
  /** Part of a name or email, or the start of a word in a position ("build", "mentor", "software member"). */
  q?: string;
  role?: Role;
  subteam?: Subteam;
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function pickEnum<T extends string>(values: Record<string, T>, v: string | undefined): T | undefined {
  return v && (Object.values(values) as string[]).includes(v) ? (v as T) : undefined;
}

/** Read the Team members filters from the URL (`?q=&role=&subteam=`), ignoring anything unexpected. */
export function parseTeamMemberFilters(sp: SearchParams): TeamMemberFilters {
  return {
    q: cleanSearchText(first(sp.q), TEAM_MEMBER_SEARCH_MAX),
    role: pickEnum(Role, first(sp.role)),
    subteam: pickEnum(Subteam, first(sp.subteam)),
  };
}

export function hasTeamMemberFilters(filters: TeamMemberFilters): boolean {
  return !!(filters.q || filters.role || filters.subteam);
}

/** Everything a member may see about a teammate. */
export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  subteam: Subteam | null;
  /** Owner (the site owner flag), shown as a badge. */
  isAdmin: boolean;
  lastSeenAt: Date | null;
}

/** The only columns this page ever reads. */
const teamMemberSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  subteam: true,
  isAdmin: true,
  lastSeenAt: true,
} as const satisfies Prisma.UserSelect;

export interface TeamMemberList {
  people: TeamMember[];
  /** Everyone matching the filters (can be more than `people` past TEAM_MEMBERS_MAX). */
  total: number;
}

/**
 * The positions (as the list shows them: "Build Leader", "Software member", "Mentor") with a word starting with `q`,
 * as `where` clauses. Searching "build" finds the build team, "mentor" the mentors.
 */
function positionsMatching(q: string): Prisma.UserWhereInput[] {
  if (q.length < POSITION_SEARCH_MIN) return [];
  const needle = ` ${q.toLowerCase()}`;
  const matches = (role: Role, subteam: Subteam | null) => ` ${describeRole(role, subteam).toLowerCase()}`.includes(needle);
  return ROLES.flatMap((role): Prisma.UserWhereInput[] => {
    const subteams = [null, ...SUBTEAMS].filter((subteam) => matches(role, subteam));
    // Most positions read the same whatever the subteam ("Mentor"); only members are "Build member" etc.
    return subteams.length === SUBTEAMS.length + 1 ? [{ role }] : subteams.map((subteam) => ({ role, subteam }));
  });
}

/** Names in alphabetical order whatever the database's collation ("jason", "Élodie" don't sink below "Zara"). */
const nameOrder = new Intl.Collator("en", { sensitivity: "base" });

/** ACTIVE accounts matching the filters, by name (at most TEAM_MEMBERS_MAX). The viewer must be ACTIVE. */
export async function listTeamMembers(
  actor: Pick<Actor, "status">,
  filters: TeamMemberFilters,
  db: Db = prisma,
): Promise<TeamMemberList> {
  if (actor.status !== "ACTIVE") throw new ForbiddenError();
  const and: Prisma.UserWhereInput[] = [{ status: "ACTIVE" }];
  const q = cleanSearchText(filters.q, TEAM_MEMBER_SEARCH_MAX);
  if (q) {
    const text = escapeLike(q);
    and.push({
      OR: [
        { name: { contains: text, mode: "insensitive" } },
        { email: { contains: text, mode: "insensitive" } },
        ...positionsMatching(q),
      ],
    });
  }
  if (filters.role) and.push({ role: filters.role });
  if (filters.subteam) and.push({ subteam: filters.subteam });
  const where: Prisma.UserWhereInput = { AND: and };

  const [people, total] = await Promise.all([
    // The database order only decides who's in the first TEAM_MEMBERS_MAX; the list is then sorted by name below.
    db.user.findMany({ where, select: teamMemberSelect, orderBy: [{ name: "asc" }, { id: "asc" }], take: TEAM_MEMBERS_MAX }),
    db.user.count({ where }),
  ]);
  people.sort((a, b) => nameOrder.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { people, total };
}

/**
 * Where someone with admin access edits this teammate (Admin → People), or null when they can't
 * (members, or an account the guardrails keep from them — `canManageAccount`). Everyone listed is ACTIVE.
 */
export function teamMemberAdminHref(actor: Pick<Actor, "id" | "role" | "subteam" | "isAdmin">, person: TeamMember): string | null {
  return canManageAccount(actor, { id: person.id, role: person.role, isAdmin: person.isAdmin, status: "ACTIVE" })
    ? `/admin/users/${person.id}`
    : null;
}
