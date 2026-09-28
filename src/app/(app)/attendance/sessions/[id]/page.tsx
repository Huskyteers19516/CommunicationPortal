import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LiveCodePanel, LiveRefresh } from "@/components/attendance/live-code";
import { SessionPeople } from "@/components/attendance/session-people";
import { DeleteSessionButton, SessionNoteForm, SessionOpenButtons } from "@/components/attendance/session-forms";
import { BackLink } from "@/components/tasks/back-link";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ATTENDANCE_EDIT_DAYS, ATTENDANCE_KIND_LABELS, formatClock } from "@/lib/attendance";
import { formatDateOnly, todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canRunAttendance } from "@/server/permissions";
import { getRunnerSession } from "@/server/queries/attendance";

export const metadata: Metadata = { title: "Take attendance" };

/**
 * The live screen for one session (runners only): the rotating QR code to put on the projector, the live
 * count and roster (refreshed every few seconds), adding/removing people by hand, "What we did", Close, and
 * Delete (started by mistake). Past sessions open here too (from Attendance and the reports) to fix them;
 * ones older than ATTENDANCE_EDIT_DAYS are read-only except for teachers, mentors, and owners.
 */
export default async function AttendanceSessionPage({ params }: PageProps<"/attendance/sessions/[id]">) {
  const actor = await requireActiveUser();
  if (!canRunAttendance(actor)) notFound();
  const { id } = await params;
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone);
  const session = await getRunnerSession(actor, id, today);
  if (!session) notFound();

  const kindLabel = ATTENDANCE_KIND_LABELS[session.kind];
  const dayLabel = formatDateOnly(session.date, today);
  const live = session.open && session.isToday;
  const count = session.roster.length;
  const { canEdit } = session;

  return (
    <>
      <BackLink href="/attendance">Attendance</BackLink>
      <PageHeader
        title={`${kindLabel} attendance`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>
              {dayLabel}
              {session.openedByName ? ` · started by ${session.openedByName}` : ""}
            </span>
            <Badge tone={live ? "green" : "gray"}>{live ? "Open" : "Closed"}</Badge>
          </span>
        }
        actions={
          canEdit && (live || session.isToday) ? (
            <SessionOpenButtons sessionId={session.id} kind={session.kind} open={live} canReopen={session.isToday} />
          ) : undefined
        }
      />
      {live && <LiveRefresh />}
      {!canEdit && (
        <Alert tone="info" title="Read only" className="mb-6">
          This attendance is from more than {ATTENDANCE_EDIT_DAYS} days ago. Only teachers, mentors, and owners can change it now.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {live ? (
            <Card>
              <CardBody>
                <LiveCodePanel
                  sessionId={session.id}
                  title={`${kindLabel} · ${dayLabel}`}
                  count={count}
                  saidYes={session.saidYesCount}
                  latest={session.roster.slice(0, 3).map((r) => r.name)}
                />
              </CardBody>
            </Card>
          ) : (
            <Alert tone="info" title="Attendance is closed">
              {session.closedAt
                ? `Closed at ${formatClock(session.closedAt, timeZone)}${session.isToday ? "" : ` on ${dayLabel}`}.`
                : "This session was for another day."}
              {canEdit ? " You can still add or remove people by hand." : ""}
            </Alert>
          )}

          <Card>
            <CardHeader title="What we did" />
            <CardBody>
              {canEdit ? (
                <SessionNoteForm sessionId={session.id} note={session.note} />
              ) : (
                <p className="whitespace-pre-line text-sm text-ink-800 wrap-anywhere">
                  {session.note || <span className="text-ink-500">Nothing written.</span>}
                </p>
              )}
            </CardBody>
          </Card>

          {session.canDelete && (
            <Card>
              <CardHeader
                title="Started by mistake?"
                description="Delete it so it doesn't count as held in the two-week report."
              />
              <CardBody>
                <DeleteSessionButton sessionId={session.id} kind={session.kind} dayLabel={dayLabel} />
              </CardBody>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-ink-500">Checked in</p>
              <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-ink-900" data-testid="attendance-count">
                {count}
              </p>
            </div>
            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-ink-500">Said they&apos;d come</p>
              <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-ink-900">{session.saidYesCount}</p>
            </div>
          </div>
          {live && (
            <p className="text-xs text-ink-500">
              Tip: count the room now and then. A code or link someone passes on checks people in too, so “Checked in”
              should match the headcount.
            </p>
          )}
          <SessionPeople
            sessionId={session.id}
            roster={session.roster.map((r) => ({
              id: r.id,
              name: r.name,
              subteam: r.subteam,
              method: r.method,
              time: formatClock(r.checkedInAt, timeZone),
              markedByName: r.markedByName,
            }))}
            expected={session.expected.map((p) => ({ id: p.id, name: p.name, subteam: p.subteam, answer: p.answer, note: p.note }))}
            others={session.others.map((p) => ({ id: p.id, name: p.name, subteam: p.subteam }))}
            readOnly={!canEdit}
          />
        </div>
      </div>
    </>
  );
}
