import type { DateOnly } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { getTodayNoShows } from "@/server/queries/attendance";
import { TodayNoShows } from "./no-shows";

/**
 * The Today page, for admins, on days with attendance: who said they'd come but isn't checked in, per session, with
 * quick actions (part credit or No credit) and a link to the session — folded to the names while it's still open.
 * Nothing when nobody's missing.
 */
export async function TodayNoShowsCard({ actor, today }: { actor: Actor; today: DateOnly }) {
  const data = await getTodayNoShows(actor, today);
  if (!data) return null;
  return (
    <TodayNoShows
      canGiveExtraCredit={data.canGiveExtraCredit}
      actorId={actor.id}
      sessions={data.sessions.map((s) => ({
        id: s.id,
        kind: s.kind,
        open: s.open,
        people: s.people.map((p) => ({ id: p.id, name: p.name, subteam: p.subteam, answer: p.answer, note: p.note })),
      }))}
    />
  );
}
