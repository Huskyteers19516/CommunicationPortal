import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TeamMemberList } from "@/components/people/team-member-list";
import type { Actor } from "@/server/actor";
import { ForbiddenError } from "@/server/errors";
import {
  TEAM_MEMBERS_MAX,
  hasTeamMemberFilters,
  listTeamMembers,
  parseTeamMemberFilters,
  teamMemberAdminHref,
  type TeamMember,
} from "@/server/queries/people";
import { createTestDb, type TestDb } from "./helpers/db";
import { TEST_NOW, makeUser } from "./helpers/factories";

// Team members (/people): every ACTIVE account, visible to every ACTIVE person, with only member-safe fields.

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t?.drop();
});

let member: Actor;
let owner: Actor;
let buildLeader: Actor;
let captain: Actor;

// A small team: every position, plus accounts that must never show up (waiting, turned down, left the team).
beforeEach(async () => {
  await t.db.user.deleteMany();
  owner = await makeUser(t.db, { name: "Olivia Owner", email: "olivia@example.com", role: "MENTOR", isAdmin: true });
  captain = await makeUser(t.db, { name: "Cam Captain", email: "cam@example.com", role: "CAPTAIN" });
  buildLeader = await makeUser(t.db, { name: "Bo Builder", email: "bo@robots.org", role: "BUILD_LEADER" });
  member = await makeUser(t.db, { name: "Maya Member", email: "maya@example.com", role: "MEMBER", subteam: "SOFTWARE" });
  await makeUser(t.db, { name: "Ada Business", email: "ada@example.com", role: "MEMBER", subteam: "BUSINESS" });
  await makeUser(t.db, { name: "Pat Pending", email: "pat@example.com", role: "BUILD_LEADER", status: "PENDING" });
  await makeUser(t.db, { name: "Rex Rejected", email: "rex@example.com", role: "MENTOR", status: "REJECTED" });
  await makeUser(t.db, { name: "Dee Disabled", email: "dee@example.com", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
  await t.db.user.update({ where: { id: member.id }, data: { lastSeenAt: TEST_NOW } });
});

const names = (people: TeamMember[]) => people.map((p) => p.name);

describe("listTeamMembers", () => {
  it("lists only ACTIVE people, by name", async () => {
    const { people, total } = await listTeamMembers(member, {}, t.db);
    expect(names(people)).toEqual(["Ada Business", "Bo Builder", "Cam Captain", "Maya Member", "Olivia Owner"]);
    expect(total).toBe(5);
  });

  it("returns only member-safe fields (never the password hash, sessions, approval info, or email preferences)", async () => {
    await t.db.session.create({ data: { tokenHash: `tok-${member.id}`, userId: member.id, expiresAt: new Date(TEST_NOW.getTime() + 86_400_000) } });
    await t.db.user.update({ where: { id: buildLeader.id }, data: { approvedAt: TEST_NOW, approvedById: owner.id } });
    const { people } = await listTeamMembers(member, {}, t.db);
    for (const p of people) {
      expect(Object.keys(p).sort()).toEqual(["email", "id", "isAdmin", "lastSeenAt", "name", "role", "subteam"]);
    }
    const maya = people.find((p) => p.id === member.id);
    expect(maya).toEqual({
      id: member.id,
      name: "Maya Member",
      email: "maya@example.com",
      role: "MEMBER",
      subteam: "SOFTWARE",
      isAdmin: false,
      lastSeenAt: TEST_NOW,
    });
    expect(people.find((p) => p.id === owner.id)).toMatchObject({ isAdmin: true, lastSeenAt: null });
  });

  it("searches name or email (any case) and filters by position and subteam, still ACTIVE only", async () => {
    const list = async (filters: Parameters<typeof listTeamMembers>[1]) => names((await listTeamMembers(member, filters, t.db)).people);
    expect(await list({ q: "MAYA" })).toEqual(["Maya Member"]);
    expect(await list({ q: "robots.ORG" })).toEqual(["Bo Builder"]);
    // "pat" / "rex" / "dee" exist, but aren't ACTIVE.
    expect(await list({ q: "pat" })).toEqual([]);
    expect(await list({ q: "dee@" })).toEqual([]);
    expect(await list({ role: "BUILD_LEADER" })).toEqual(["Bo Builder"]);
    expect(await list({ role: "MENTOR" })).toEqual(["Olivia Owner"]);
    expect(await list({ role: "MEMBER" })).toEqual(["Ada Business", "Maya Member"]);
    expect(await list({ subteam: "BUILD" })).toEqual(["Bo Builder"]);
    expect(await list({ subteam: "SOFTWARE", role: "MEMBER", q: "example" })).toEqual(["Maya Member"]);
    expect(await list({ q: "nobody" })).toEqual([]);
    const counted = await listTeamMembers(member, { role: "MEMBER" }, t.db);
    expect(counted.total).toBe(2);
  });

  it("finds people by position: a word starting with the search, as the list shows it", async () => {
    await makeUser(t.db, { name: "Kai Nakamura", email: "kai@example.com", role: "MEMBER", subteam: "BUILD" });
    const list = async (filters: Parameters<typeof listTeamMembers>[1]) => names((await listTeamMembers(member, filters, t.db)).people);
    // Only the position matches here (not the name or email).
    expect(await list({ q: "software" })).toEqual(["Maya Member"]);
    expect(await list({ q: "MENTOR" })).toEqual(["Olivia Owner"]);
    expect(await list({ q: "leader" })).toEqual(["Bo Builder"]); // Pat (a pending Build Leader) stays hidden
    expect(await list({ q: "lead" })).toEqual(["Bo Builder"]);
    expect(await list({ q: "Build Leader" })).toEqual(["Bo Builder"]);
    expect(await list({ q: "build member" })).toEqual(["Kai Nakamura"]); // not Dee (disabled)
    expect(await list({ q: "business member" })).toEqual(["Ada Business"]);
    expect(await list({ q: "build" })).toEqual(["Bo Builder", "Kai Nakamura"]);
    expect(await list({ q: "member" })).toEqual(["Ada Business", "Kai Nakamura", "Maya Member"]);
    // The start of a word only, and at least 3 letters ("me" would otherwise pull in every member and mentor).
    expect(await list({ q: "ntor" })).toEqual([]);
    expect(await list({ q: "me" })).toEqual(["Maya Member"]);
    // Still combined with the menus.
    expect(await list({ q: "software", role: "MENTOR" })).toEqual([]);
    expect((await listTeamMembers(member, { q: "member" }, t.db)).total).toBe(3);
  });

  it("searches for %, _ and \\ literally (not as wildcards)", async () => {
    await makeUser(t.db, { name: "Sam Smith", email: "sam_smith@example.com", role: "MEMBER", subteam: "BUILD" });
    await makeUser(t.db, { name: "Percy 100%", email: "percy@example.com", role: "MEMBER", subteam: "BUILD" });
    await makeUser(t.db, { name: "Back\\Slash", email: "slash@example.com", role: "MEMBER", subteam: "BUILD" });
    const list = async (q: string) => names((await listTeamMembers(member, { q }, t.db)).people);
    expect(await list("_")).toEqual(["Sam Smith"]);
    expect(await list("m_s")).toEqual(["Sam Smith"]);
    expect(await list("%")).toEqual(["Percy 100%"]);
    expect(await list("0%")).toEqual(["Percy 100%"]);
    expect(await list("\\")).toEqual(["Back\\Slash"]);
    expect(await list("_a")).toEqual([]);
  });

  it("ignores control characters in the search (a NUL byte would make Postgres fail the page)", async () => {
    const all = await listTeamMembers(member, {}, t.db);
    const nul = await listTeamMembers(member, { q: "\u0000" }, t.db);
    expect(nul.total).toBe(all.total);
    expect(names((await listTeamMembers(member, parseTeamMemberFilters({ q: "ma\u0000ya" }), t.db)).people)).toEqual(["Maya Member"]);
    expect(names((await listTeamMembers(member, { q: "ma\u0000ya\u001f" }, t.db)).people)).toEqual(["Maya Member"]);
  });

  it("sorts by name alphabetically, whatever the case or accents", async () => {
    await makeUser(t.db, { name: "Zara Ahmed", email: "zara@example.com", role: "MEMBER", subteam: "BUILD" });
    await makeUser(t.db, { name: "jason wu", email: "jason@example.com", role: "MEMBER", subteam: "BUILD" });
    await makeUser(t.db, { name: "Élodie Martin", email: "elodie@example.com", role: "MEMBER", subteam: "BUILD" });
    const { people } = await listTeamMembers(member, {}, t.db);
    expect(names(people)).toEqual([
      "Ada Business",
      "Bo Builder",
      "Cam Captain",
      "Élodie Martin",
      "jason wu",
      "Maya Member",
      "Olivia Owner",
      "Zara Ahmed",
    ]);
  });

  it("is for every ACTIVE person, whatever their position", async () => {
    for (const viewer of [member, buildLeader, captain, owner]) {
      expect((await listTeamMembers(viewer, {}, t.db)).total).toBe(5);
    }
  });

  it("refuses viewers who aren't ACTIVE", async () => {
    for (const status of ["PENDING", "REJECTED", "DISABLED"] as const) {
      const viewer = await makeUser(t.db, { role: "MEMBER", status });
      await expect(listTeamMembers(viewer, {}, t.db)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it(`stops at ${TEAM_MEMBERS_MAX} people but counts everyone`, async () => {
    await t.db.user.createMany({
      data: Array.from({ length: TEAM_MEMBERS_MAX + 5 }, (_, i) => ({
        name: `Zz Person ${String(i).padStart(3, "0")}`,
        email: `zz${i}@example.com`,
        passwordHash: "x",
        role: "MEMBER" as const,
        subteam: "BUILD" as const,
        status: "ACTIVE" as const,
      })),
    });
    const { people, total } = await listTeamMembers(member, {}, t.db);
    expect(people).toHaveLength(TEAM_MEMBERS_MAX);
    expect(total).toBe(TEAM_MEMBERS_MAX + 10);
    expect(people[0].name).toBe("Ada Business");
  });
});

describe("parseTeamMemberFilters", () => {
  it("keeps valid values and ignores anything unexpected", () => {
    expect(parseTeamMemberFilters({ q: "  maya ", role: "BUILD_LEADER", subteam: "BUILD" })).toEqual({
      q: "maya",
      role: "BUILD_LEADER",
      subteam: "BUILD",
    });
    expect(parseTeamMemberFilters({ q: "   ", role: "OWNER", subteam: ["NOPE", "BUILD"], status: "PENDING", page: "2" })).toEqual({
      q: undefined,
      role: undefined,
      subteam: undefined,
    });
    expect(parseTeamMemberFilters({ role: ["MENTOR", "CAPTAIN"] })).toEqual({ q: undefined, role: "MENTOR", subteam: undefined });
    expect(parseTeamMemberFilters({ q: "x".repeat(500) }).q).toHaveLength(100);
    // Control characters (e.g. ?q=%00) are dropped.
    expect(parseTeamMemberFilters({ q: "\u0000" }).q).toBeUndefined();
    expect(parseTeamMemberFilters({ q: " \u0000\t\n " }).q).toBeUndefined();
    expect(parseTeamMemberFilters({ q: "ma\u0000ya\u007f" }).q).toBe("maya");
    expect(parseTeamMemberFilters({})).toEqual({ q: undefined, role: undefined, subteam: undefined });
  });

  it("hasTeamMemberFilters is true for any filter", () => {
    expect(hasTeamMemberFilters({})).toBe(false);
    expect(hasTeamMemberFilters({ q: "a" })).toBe(true);
    expect(hasTeamMemberFilters({ role: "MEMBER" })).toBe(true);
    expect(hasTeamMemberFilters({ subteam: "BUILD" })).toBe(true);
  });
});

describe("teamMemberAdminHref", () => {
  it("links into Admin → People only where the viewer can manage the person", async () => {
    const { people } = await listTeamMembers(member, {}, t.db);
    const hrefs = (viewer: Actor) => Object.fromEntries(people.map((p) => [p.name, teamMemberAdminHref(viewer, p)]));
    const href = (a: Actor) => `/admin/users/${a.id}`;

    // Members: never.
    expect(Object.values(hrefs(member)).every((h) => h === null)).toBe(true);

    // A subteam leader: members and themselves, never the captain, mentors, or owners.
    expect(hrefs(buildLeader)).toMatchObject({
      "Maya Member": href(member),
      "Bo Builder": href(buildLeader),
      "Cam Captain": null,
      "Olivia Owner": null,
    });

    // The captain: leaders and members, not the owner.
    expect(hrefs(captain)).toMatchObject({ "Bo Builder": href(buildLeader), "Maya Member": href(member), "Olivia Owner": null });

    // Owners: everyone.
    expect(Object.values(hrefs(owner)).every((h) => h?.startsWith("/admin/users/"))).toBe(true);
  });
});

describe("TeamMemberList", () => {
  const render = async (viewer: Actor) => {
    const { people } = await listTeamMembers(viewer, {}, t.db);
    const rows = people.map((p) => ({ ...p, adminHref: teamMemberAdminHref(viewer, p) }));
    return renderToStaticMarkup(createElement(TeamMemberList, { people: rows, now: TEST_NOW, timeZone: "America/Los_Angeles" }));
  };
  const count = (html: string, text: string) => html.split(text).length - 1;

  it("shows members names, emails, and last seen, but no links into Admin or clickable-looking rows", async () => {
    const html = await render(member);
    expect(html).not.toContain("/admin");
    expect(html).toContain('href="mailto:maya@example.com"');
    expect(html).not.toContain("Pat Pending");
    // Phone cards: "Seen …" for people who signed in, "Never signed in" (not "Seen Never") for the rest.
    expect(html).toContain("Seen just now");
    expect(count(html, "Never signed in")).toBe(4);
    expect(html).not.toContain("Seen Never");
    expect(html).not.toContain("hover:bg-ink-50");
  });

  it("marks the rows that open Admin → People for people with admin access", async () => {
    const leaderHtml = await render(buildLeader);
    // The build leader manages members and themselves (Ada, Bo, Maya): a link, a chevron, and a hover, in both layouts.
    expect(count(leaderHtml, 'href="/admin/users/')).toBe(3 * 2);
    expect(count(leaderHtml, "lucide-chevron-right")).toBe(3 * 2);
    expect(count(leaderHtml, "hover:bg-ink-50")).toBe(3);
    expect(leaderHtml).not.toContain(`/admin/users/${owner.id}`);
    expect(leaderHtml).not.toContain(`/admin/users/${captain.id}`);

    const ownerHtml = await render(owner);
    expect(count(ownerHtml, 'href="/admin/users/')).toBe(5 * 2);
    expect(count(ownerHtml, "hover:bg-ink-50")).toBe(5);
  });
});
