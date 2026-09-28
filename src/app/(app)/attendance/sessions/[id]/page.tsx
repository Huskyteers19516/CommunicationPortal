import { History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveCodePanel, LiveRefresh } from "@/components/attendance/live-code";
import { NoShowList } from "@/components/attendance/no-shows";
import { SessionPeople } from "@/components/attendance/session-people";
import { DeleteSessionButton, SessionNoteForm, SessionOpenButtons } from "@/components/attendance/session-forms";
import { BackLink } from "@/components/tasks/back-link";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ATTENDANCE_EDIT_DAYS, ATTENDANCE_KIND_LABELS, creditLabel, formatClock, formatPeriod } from "@/lib/attendance";
import { formatDateOnly, formatDateTime, todayInTimezone } from "@/lib/dates";
import { describeAttendanceChange } from "@/server/attendance/changes";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canFixAttendance } from "@/server/permissions";
import { getRunnerSession } from "@/server/queries/attendance";

export const metadata: Metadata = { title: "Take attendance" };

/**
 * One session's page, for everyone with admin access (members get 404). While it's open today, runners (teachers,
 * the Business leader, the captain, mentors, owners) get the rotating QR code for the projector first (Full screen
 * at its top), and who said they'd come but isn't on the list sits folded under the counts (they may still be on
 * their way); once it's closed, that list is at the top with its quick actions (part credit or No credit). Runners
 * also get Close / Reopen (Close for a session left open from an earlier day too, which sends the no-show post),
 * "What we did", and Delete (started by mistake). Every admin fixes the list at any time: each person's credit (a
 * menu with what they may set), their week ("1⅔ of 2"), Remove, and adding people by hand. History lists the
 * changes made to it. While it's open the page refreshes itself every few seconds.
 */
export default async function AttendanceSessionPage({ params }: PageProps<"/attendance/sessions/[id]">) {
  const actor = await requireActiveUser();
  if (!canFixAttendance(actor)) notFound();
  const { id } = await params;
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone);
  const session = await getRunnerSession(actor, id, today);
  if (!session) notFound();

  const kindLabel = ATTENDANCE_KIND_LABELS[session.kind];
  const dayLabel = formatDateOnly(session.date, today);
  const live = session.open && session.isToday;
  // Left open on an earlier day (nobody closed it): it can still be closed, which sends the no-show list.
  const leftOpen = session.open && !session.isToday;
  const { canRun } = session;
  const noShows = (
    <NoShowList
      key={session.id}
      sessionId={session.id}
      kind={session.kind}
      people={session.noShows.map((p) => ({ id: p.id, name: p.name, subteam: p.subteam, answer: p.answer, note: p.note }))}
      canGiveExtraCredit={session.canGiveExtraCredit}
      actorId={actor.id}
      live={live}
      collapsible={live}
      title={live ? "Said they'd come — not checked in yet" : "Said they'd come — didn't check in"}
      description={
        live
          ? "They may still be on their way: when they scan in, it counts as usual. If they were here for part of it, give part credit; if they weren't, No credit."
          : "If they were there for part of it, give part credit; if they weren't, No credit."
      }
      className={live ? undefined : "mb-6"}
    />
  );

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
            <Badge tone={live ? "green" : leftOpen ? "yellow" : "gray"}>{live ? "Open" : leftOpen ? "Still open" : "Closed"}</Badge>
          </span>
        }
        actions={
          canRun && (session.open || session.isToday) ? (
            <SessionOpenButtons sessionId={session.id} kind={session.kind} open={session.open} canReopen={session.isToday} />
          ) : undefined
        }
      />
      {live && <LiveRefresh />}

      {/* Once it's closed, the people to deal with come first. */}
      {!live && noShows}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {live && canRun ? (
            <Card>
              <CardBody>
                <LiveCodePanel
                  sessionId={session.id}
                  title={`${kindLabel} · ${dayLabel}`}
                  scanned={session.scannedCount}
                  saidYes={session.saidYesCount}
                  // Scans only: people added by hand aren't in the room (and their credit is the admins' business).
                  latest={session.roster
                    .filter((r) => r.method !== "MANUAL" && r.credit.credit > 0)
                    .slice(0, 3)
                    .map((r) => r.name)}
                />
              </CardBody>
            </Card>
          ) : live ? (
            <Alert tone="info" title="Attendance is open">
              People are checking in now; this page updates on its own. You can add people by hand or change credits any time.
            </Alert>
          ) : leftOpen ? (
            <Alert tone="warning" title={`Still open from ${dayLabel}`}>
              Nobody can check in to it now.{" "}
              {canRun
                ? "Close it to send the list of people who said they'd come and didn't to the leaders' Discord."
                : "Ask someone who runs attendance to close it, so the no-show list goes to the leaders' Discord."}{" "}
              You can still add or remove people by hand and change credits.
            </Alert>
          ) : (
            <Alert tone="info" title="Attendance is closed">
              {session.closedAt && `Closed at ${formatClock(session.closedAt, timeZone)}${session.isToday ? "" : ` on ${dayLabel}`}. `}
              You can still add or remove people by hand and change credits.
            </Alert>
          )}

          <Card>
            <CardHeader title="What we did" />
            <CardBody>
              {session.canEditNote ? (
                <SessionNoteForm sessionId={session.id} note={session.note} />
              ) : (
                <div className="space-y-2">
                  <p className="whitespace-pre-line text-sm text-ink-800 wrap-anywhere">
                    {session.note || <span className="text-ink-500">Nothing written.</span>}
                  </p>
                  {canRun && (
                    <p className="text-xs text-ink-500">
                      This is from more than {ATTENDANCE_EDIT_DAYS} days ago. Only teachers, mentors, and owners can change it now.
                    </p>
                  )}
                </div>
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
              <p className="text-sm text-ink-500">Scanned in</p>
              <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-ink-900" data-testid="attendance-count">
                {session.scannedCount}
              </p>
              {session.handCount > 0 && <p className="text-xs text-ink-500">+ {session.handCount} added by hand</p>}
            </div>
            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-ink-500">Said they&apos;d come</p>
              <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-ink-900">{session.saidYesCount}</p>
            </div>
          </div>
          {live && canRun && (
            <p className="text-xs text-ink-500">
              Tip: count the room now and then. A code or link someone passes on checks people in too, so “Scanned in”
              should match the headcount.
            </p>
          )}
          {live && noShows}
          <SessionPeople
            sessionId={session.id}
            kind={session.kind}
            weeklyTarget={session.weeklyTarget}
            weekLabel={formatPeriod(session.week, today)}
            canGiveExtraCredit={session.canGiveExtraCredit}
            actorId={actor.id}
            roster={session.roster.map((r) => ({
              id: r.id,
              name: r.name,
              subteam: r.subteam,
              method: r.method,
              time: formatClock(r.checkedInAt, timeZone),
              markedByName: r.markedByName,
              option: r.credit.option,
              creditLabel: creditLabel(r.credit.credit, r.credit.creditKind),
              credit: r.credit.credit,
              // Adding someone by hand sets their credit too: "Added by hand by X" already says who.
              creditChangedByName:
                r.method === "MANUAL" && r.credit.changedAt?.getTime() === r.checkedInAt.getTime() ? null : r.credit.changedByName,
              week: r.week.total,
            }))}
            others={session.others.map((p) => ({ id: p.id, name: p.name, subteam: p.subteam }))}
          />

          <Card>
            <CardHeader
              title="History"
              description="Changes made to this list: people added by hand, taken off, credits changed, and scans over a hand entry."
            />
            {session.history.length === 0 ? (
              <CardBody>
                <p className="text-sm text-ink-500">No changes by admins yet.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-ink-100" aria-label="History">
                {session.history.map((c) => (
                  <li key={c.id} className="space-y-0.5 px-4 py-2.5 text-sm sm:px-5">
                    <p className="text-ink-800 wrap-anywhere">{describeAttendanceChange(c, today)}</p>
                    <p className="text-xs text-ink-500">{formatDateTime(c.createdAt, timeZone)}</p>
                  </li>
                ))}
              </ul>
            )}
            <CardBody className="border-t border-ink-100">
              <Link
                href="/attendance/changes"
                className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"
              >
                <History className="size-4" aria-hidden />
                All attendance changes
              </Link>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
