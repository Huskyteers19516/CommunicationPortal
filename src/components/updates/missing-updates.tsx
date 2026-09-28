import type { Subteam } from "@/generated/prisma/enums";
import { type DateOnly, formatDateOnly } from "@/lib/dates";
import { missingMeetingUpdates, subteamList } from "@/lib/meeting-updates";

/**
 * Attendance's two-week report: the meeting days (days attendance was taken) that are missing a subteam's
 * update, e.g. "Mon, Sep 21: Build". Renders nothing when every one of them has all three.
 */
export function MissingMeetingUpdates({
  days,
  updates,
  today,
}: {
  days: DateOnly[];
  updates: { meetingDate: DateOnly; subteam: Subteam }[];
  /** For the date labels (the year shows only when it differs from this day's). */
  today: DateOnly;
}) {
  const missing = missingMeetingUpdates(days, updates);
  if (missing.length === 0) return null;
  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-print-avoid-break>
      <p className="font-medium">
        Missing updates <span className="font-normal text-amber-900">· days attendance was taken</span>
      </p>
      <ul className="mt-1 space-y-0.5">
        {missing.map((m) => (
          <li key={m.date}>
            {formatDateOnly(m.date, today)}: {subteamList(m.subteams)}
          </li>
        ))}
      </ul>
    </div>
  );
}
