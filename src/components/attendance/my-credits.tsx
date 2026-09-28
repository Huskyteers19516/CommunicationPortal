import type { AttendanceKind } from "@/generated/prisma/enums";
import { ATTENDANCE_KIND_LABELS, creditLabel, memberCreditOptions, type WeekCredit } from "@/lib/attendance";
import type { CreditInfo } from "@/server/queries/attendance";
import { CreditPicker, type MyCredit } from "./credit-picker";
import { WeekProgress } from "./week-progress";

/** What the picker needs from a check-in's credit (`open`: the session is open today). */
export function myCreditProps(info: CreditInfo, open: boolean): MyCredit {
  return {
    option: info.option,
    label: creditLabel(info.credit, info.creditKind),
    credit: info.credit,
    method: info.method,
    changedByName: info.changedByName,
    untouchedByHand: info.untouchedByHand,
    open,
  };
}

/** My own scan as it came, with nothing to pick or say (Regular: "counts as 1"). */
function plainCheckIn(s: { kind: AttendanceKind; myCredit: CreditInfo }): boolean {
  const c = s.myCredit;
  return c.credit > 0 && c.method !== "MANUAL" && !c.changedByName && memberCreditOptions(s.kind).length === 0;
}

/**
 * Right after checking in (Attendance, Today, the scan page): what each of today's check-ins counts as ("Regular
 * counts as 1"; at Flex "How long are you at Flex?"; who changed it; or who added me by hand), then this week's
 * "1⅔ of 2 this week" (with what it's made of). A plain check-in is folded into the week's box ("Regular counts as
 * 1" over "1 of 2 this week"), so it isn't said twice. Pass the sessions I'm on the list of (a "No credit" one says
 * an admin marked me), with `open` = open today.
 */
export function TodayCredits({
  sessions,
  week,
  target,
}: {
  sessions: { id: string; kind: AttendanceKind; open: boolean; myCredit: CreditInfo | null }[];
  week: WeekCredit | null;
  target: number;
}) {
  const mine = sessions.filter((s): s is typeof s & { myCredit: CreditInfo } => s.myCredit !== null);
  if (mine.length === 0 && !week) return null;
  const folded = week ? mine.filter(plainCheckIn) : [];
  const rest = mine.filter((s) => !folded.includes(s));
  const lead = folded
    .map((s) => `${ATTENDANCE_KIND_LABELS[s.kind]} counts as ${creditLabel(s.myCredit.credit, s.myCredit.creditKind)}`)
    .join(" · ");
  return (
    <div className="space-y-3">
      {rest.map((s) => (
        <CreditPicker key={s.id} sessionId={s.id} kind={s.kind} credit={myCreditProps(s.myCredit, s.open)} target={week ? target : null} />
      ))}
      {week && <WeekProgress week={week} target={target} breakdown lead={lead || undefined} />}
    </div>
  );
}
