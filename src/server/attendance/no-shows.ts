// "Said they'd come — not checked in": people who answered Coming? with Yes or Half for a Regular session's day
// (Attend Flex? Yes for a Flex session) and have no record on that session. A record of any credit — "No credit"
// included — means an admin already dealt with them. Only ACTIVE accounts count, and never the person who started
// the session (they ran practice, so they were there: not on the lists, the Today card, or the Discord post).
//
// Shared by the live screen, the Today card for admins, and closing a session (the Discord post). No "server-only":
// services and tests use it with their own database.
import type { AttendanceKind, Role, RsvpAnswer, Subteam } from "@/generated/prisma/enums";
import { dbToDateOnly } from "@/lib/dates";
import type { Db } from "../db";

export interface NoShow {
  id: string;
  name: string;
  subteam: Subteam | null;
  role: Role;
  /** What they answered (Regular: Yes / Half; Flex: Yes). */
  answer: RsvpAnswer;
  note: string;
}

export interface NoShowSession {
  id: string;
  /** The session's day (@db.Date). */
  date: Date;
  kind: AttendanceKind;
  /** Who started it (left out: they ran it). */
  openedById?: string | null;
}

/** Each session's no-shows, by name. Sessions without any get an empty list. */
export async function findNoShows(db: Db, sessions: NoShowSession[]): Promise<Map<string, NoShow[]>> {
  const out = new Map<string, NoShow[]>(sessions.map((s) => [s.id, []]));
  if (sessions.length === 0) return out;
  const dates = [...new Map(sessions.map((s) => [s.date.getTime(), s.date])).values()];
  const [rsvps, records] = await Promise.all([
    db.attendanceRsvp.findMany({
      where: { date: { in: dates }, user: { status: "ACTIVE" }, OR: [{ regular: { in: ["YES", "HALF"] } }, { flex: "YES" }] },
      select: {
        date: true,
        regular: true,
        flex: true,
        note: true,
        user: { select: { id: true, name: true, subteam: true, role: true } },
      },
    }),
    db.attendanceRecord.findMany({ where: { sessionId: { in: sessions.map((s) => s.id) } }, select: { sessionId: true, userId: true } }),
  ]);
  const onList = new Set(records.map((r) => `${r.sessionId}|${r.userId}`));
  for (const s of sessions) {
    const day = dbToDateOnly(s.date);
    const list = out.get(s.id) as NoShow[];
    for (const r of rsvps) {
      if (dbToDateOnly(r.date) !== day || onList.has(`${s.id}|${r.user.id}`) || r.user.id === s.openedById) continue;
      const answer = s.kind === "REGULAR" ? r.regular : r.flex;
      const said = s.kind === "REGULAR" ? answer === "YES" || answer === "HALF" : answer === "YES";
      if (!said || !answer) continue;
      list.push({ ...r.user, answer, note: r.note });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}
