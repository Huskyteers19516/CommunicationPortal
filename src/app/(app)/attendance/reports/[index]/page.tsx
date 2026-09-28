import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { PrintButton } from "@/components/attendance/print-button";
import { BackLink } from "@/components/tasks/back-link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { MissingMeetingUpdates } from "@/components/updates/missing-updates";
import { PageHeader } from "@/components/ui/page-header";
import { ATTENDANCE_KIND_LABELS, formatPeriod, parseReportIndex } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { formatDateOnly, formatDateTime, todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canPlanAttendance, canRunAttendance } from "@/server/permissions";
import { getAttendanceReport } from "@/server/queries/attendance";

export const metadata: Metadata = { title: "Two-week report" };

// Printing: only the report (no menus, buttons, or page padding).
const PRINT_CSS = `
@media print {
  @page { margin: 12mm; }
  html, body { background: #fff !important; }
  aside, header, nav[aria-label="Quick"], [data-print-hidden] { display: none !important; }
  main { margin: 0 !important; padding: 0 !important; }
  [data-print-avoid-break] { break-inside: avoid; }
  .overflow-x-auto { overflow: visible !important; }
}
`;

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={cn("px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500", className)}>{children}</th>;
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2 align-top text-sm text-ink-800", className)}>{children}</td>;
}

/** Wide tables scroll sideways inside themselves (keyboard too); phones get stacked rows instead. */
function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // Focusable so it scrolls by keyboard too.
    <div
      className="hidden overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 sm:block print:block"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

/**
 * Staff: one two-week period — sessions, each person's attendance, and what got done. Print or download as CSV.
 * People who run attendance can open each session from here to fix its list or "What we did".
 */
export default async function AttendanceReportPage({ params }: PageProps<"/attendance/reports/[index]">) {
  const actor = await requireActiveUser();
  if (!canPlanAttendance(actor)) notFound();
  const index = parseReportIndex((await params).index);
  if (index === null) notFound();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone);
  const report = await getAttendanceReport(actor, index, { today, timeZone });
  if (!report) notFound();
  const { period, data } = report;
  const periodLabel = formatPeriod(period, today);
  const canRun = canRunAttendance(actor);
  const sessionLink = "inline-flex min-h-10 items-center font-medium text-brand-700 underline-offset-2 hover:underline";

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div data-print-hidden>
        <BackLink href="/attendance/reports">Reports</BackLink>
      </div>
      <PageHeader
        eyebrow="Two-week report"
        title={periodLabel}
        description={
          report.current
            ? "These two weeks so far."
            : `${formatDateOnly(period.start, today)} to ${formatDateOnly(period.end, today)}.`
        }
        actions={
          <div className="flex flex-wrap gap-2" data-print-hidden>
            <PrintButton />
            <a
              href={`/attendance/reports/${index}/csv`}
              download
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-ink-200 bg-white px-4 text-sm font-medium text-ink-800 shadow-sm hover:bg-ink-50"
            >
              <Download className="size-4" aria-hidden />
              Download CSV
            </a>
          </div>
        }
      />

      <nav aria-label="Other periods" className="-mt-2 mb-6 flex flex-wrap gap-2" data-print-hidden>
        {report.hasOlder && (
          <Link
            href={`/attendance/reports/${index - 1}`}
            className="inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
          >
            <ChevronLeft className="size-4" aria-hidden />
            Earlier two weeks
          </Link>
        )}
        {report.hasNewer && (
          <Link
            href={`/attendance/reports/${index + 1}`}
            className="inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
          >
            Later two weeks
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        )}
      </nav>

      <div className="space-y-6">
        <Card data-print-avoid-break>
          <CardHeader
            title="When attendance was taken"
            description={`${data.held.regular} Regular · ${data.held.flex} Flex`}
          />
          {data.sessions.length === 0 ? (
            <CardBody>
              <p className="text-sm text-ink-500">No attendance was taken in these two weeks.</p>
            </CardBody>
          ) : (
            <>
              <ul className="divide-y divide-ink-100 sm:hidden print:hidden" aria-label="Sessions">
                {data.sessions.map((s) => {
                  const date = formatDateOnly(s.date, today);
                  return (
                    <li key={s.id} className="space-y-0.5 px-4 py-2.5 text-sm">
                      <p className="wrap-anywhere text-ink-900">
                        {canRun ? (
                          <Link href={`/attendance/sessions/${s.id}`} className={sessionLink}>
                            {date} · {ATTENDANCE_KIND_LABELS[s.kind]}
                          </Link>
                        ) : (
                          <span className="font-medium">
                            {date} · {ATTENDANCE_KIND_LABELS[s.kind]}
                          </span>
                        )}
                        {s.openedByName && <span className="text-ink-500"> · {s.openedByName}</span>}
                      </p>
                      <p className="tabular-nums text-ink-600">
                        {s.present} came · {s.saidYes} said yes
                      </p>
                      <p className="whitespace-pre-line wrap-anywhere text-ink-800">
                        {s.note || <span className="text-ink-400">No “What we did”</span>}
                      </p>
                    </li>
                  );
                })}
              </ul>
              <TableScroll label="Sessions table">
                <table className="w-full min-w-[40rem]">
                  <thead className="border-b border-ink-100 bg-ink-50/60">
                    <tr>
                      <Th>Date</Th>
                      <Th>Kind</Th>
                      <Th>Run by</Th>
                      <Th className="text-right">Came</Th>
                      <Th className="text-right">Said yes</Th>
                      <Th>What we did</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {data.sessions.map((s) => (
                      <tr key={s.id}>
                        <Td className="whitespace-nowrap">
                          {canRun ? (
                            <Link
                              href={`/attendance/sessions/${s.id}`}
                              className={sessionLink}
                              aria-label={`${formatDateOnly(s.date, today)} ${ATTENDANCE_KIND_LABELS[s.kind]}: open to fix`}
                            >
                              {formatDateOnly(s.date, today)}
                            </Link>
                          ) : (
                            formatDateOnly(s.date, today)
                          )}
                        </Td>
                        <Td>{ATTENDANCE_KIND_LABELS[s.kind]}</Td>
                        <Td className="wrap-anywhere">{s.openedByName ?? "—"}</Td>
                        <Td className="text-right tabular-nums">{s.present}</Td>
                        <Td className="text-right tabular-nums">{s.saidYes}</Td>
                        <Td className="whitespace-pre-line wrap-anywhere">{s.note || <span className="text-ink-400">—</span>}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </>
          )}
        </Card>

        <Card>
          <CardHeader
            title="People"
            description="Sessions each person came to, out of the ones held since they joined. “Said yes” counts Yes or Half for Regular."
          />
          {data.people.length === 0 ? (
            <CardBody>
              <p className="text-sm text-ink-500">No one to list.</p>
            </CardBody>
          ) : (
            <>
              <ul className="divide-y divide-ink-100 sm:hidden print:hidden" aria-label="People">
                {data.people.map((p) => (
                  <li key={p.id} className="space-y-0.5 px-4 py-2.5 text-sm">
                    <p className="wrap-anywhere">
                      <span className="font-medium text-ink-900">{p.name}</span>
                      <span className="text-ink-500"> · {p.subteam ? SUBTEAM_LABELS[p.subteam] : "No subteam"}</span>
                    </p>
                    <p className="tabular-nums text-ink-700">
                      Regular {p.regular.attended}/{p.regular.held} · Flex {p.flex.attended}/{p.flex.held}
                      {p.saidYesMissed > 0 && <span className="font-semibold text-amber-700"> · Said yes, didn&apos;t come {p.saidYesMissed}</span>}
                      {p.cameUnanswered > 0 && ` · Came without answering ${p.cameUnanswered}`}
                    </p>
                  </li>
                ))}
              </ul>
              <TableScroll label="People table">
              <table className="w-full min-w-[40rem]">
                <thead className="border-b border-ink-100 bg-ink-50/60">
                  <tr>
                    <Th>Name</Th>
                    <Th>Subteam</Th>
                    <Th className="text-right">Regular</Th>
                    <Th className="text-right">Flex</Th>
                    <Th className="text-right">Said yes, didn&apos;t come</Th>
                    <Th className="text-right">Came without answering</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.people.map((p) => (
                    <tr key={p.id}>
                      <Td className="font-medium wrap-anywhere">{p.name}</Td>
                      <Td>{p.subteam ? SUBTEAM_LABELS[p.subteam] : "—"}</Td>
                      <Td className="text-right tabular-nums">
                        {p.regular.attended}/{p.regular.held}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {p.flex.attended}/{p.flex.held}
                      </Td>
                      <Td className={cn("text-right tabular-nums", p.saidYesMissed > 0 && "font-semibold text-amber-700")}>
                        {p.saidYesMissed}
                      </Td>
                      <Td className="text-right tabular-nums">{p.cameUnanswered}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </TableScroll>
            </>
          )}
        </Card>

        <Card>
          <CardHeader
            title="What got done"
            description="Meeting updates, checklist items approved, parts made, and notebook entries written in these two weeks."
          />
          <CardBody className="space-y-6">
            <section aria-labelledby="done-updates">
              <h3 id="done-updates" className="mb-2 font-semibold text-ink-900">
                Meeting updates <span className="font-normal text-ink-500">({report.meetingUpdates.length})</span>
              </h3>
              <MissingMeetingUpdates days={data.sessions.map((s) => s.date)} updates={report.meetingUpdates} today={report.period.end} />
              {report.meetingUpdates.length === 0 ? (
                <p className="text-sm text-ink-500">No meeting updates written.</p>
              ) : (
                <ul className="space-y-3">
                  {report.meetingUpdates.map((u) => (
                    <li key={u.id} className="text-sm text-ink-800" data-print-avoid-break>
                      <p className="font-medium text-ink-900">
                        {formatDateOnly(u.meetingDate, report.period.end)} · {SUBTEAM_LABELS[u.subteam]}
                        <span className="font-normal text-ink-500"> · written by {u.authorName ?? "a former member"}</span>
                      </p>
                      <p className="mt-0.5 whitespace-pre-wrap wrap-anywhere">{u.body}</p>
                      {u.nextSteps && (
                        <p className="mt-1 whitespace-pre-wrap text-ink-600 wrap-anywhere">
                          <span className="font-medium text-ink-700">Next time: </span>
                          {u.nextSteps}
                        </p>
                      )}
                      {u.blockers && (
                        <p className="mt-1 whitespace-pre-wrap text-ink-600 wrap-anywhere">
                          <span className="font-medium text-ink-700">Problems or help needed: </span>
                          {u.blockers}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="done-tasks" data-print-avoid-break>
              <h3 id="done-tasks" className="mb-2 font-semibold text-ink-900">
                Tasks approved <span className="font-normal text-ink-500">({report.tasks.length})</span>
              </h3>
              {report.tasks.length === 0 ? (
                <p className="text-sm text-ink-500">Nothing approved in these two weeks.</p>
              ) : (
                <ul className="space-y-1">
                  {report.tasks.map((t) => (
                    <li key={t.id} className="text-sm">
                      <Link
                        href={`/tasks/${t.id}`}
                        className="inline-flex min-h-10 items-center font-medium text-ink-900 underline-offset-2 wrap-anywhere hover:underline"
                      >
                        {t.title}
                      </Link>
                      <span className="text-ink-500"> · {t.subteam ? SUBTEAM_LABELS[t.subteam] : "Whole team"}</span>
                      <p className="text-ink-600 wrap-anywhere">{t.people.join(", ")}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="done-parts" data-print-avoid-break>
              <h3 id="done-parts" className="mb-2 font-semibold text-ink-900">
                Parts made <span className="font-normal text-ink-500">({report.parts.length})</span>
              </h3>
              {report.parts.length === 0 ? (
                <p className="text-sm text-ink-500">No parts marked done.</p>
              ) : (
                <ul className="space-y-1">
                  {report.parts.map((p) => (
                    <li key={p.id} className="text-sm text-ink-800 wrap-anywhere">
                      <span className="font-medium">{p.name}</span>
                      {p.quantity > 1 ? ` ×${p.quantity}` : ""}
                      <span className="text-ink-500">
                        {p.madeBy ? ` · ${p.madeBy}` : ""} · {formatDateTime(p.doneAt, timeZone)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="done-notebook" data-print-avoid-break>
              <h3 id="done-notebook" className="mb-2 font-semibold text-ink-900">
                Notebook entries <span className="font-normal text-ink-500">({report.notebook.length})</span>
              </h3>
              {report.notebook.length === 0 ? (
                <p className="text-sm text-ink-500">No notebook entries written.</p>
              ) : (
                <ul className="space-y-1">
                  {report.notebook.map((e) => (
                    <li key={e.id} className="text-sm text-ink-800 wrap-anywhere">
                      <span className="font-medium">{e.title || "Untitled entry"}</span>
                      <span className="text-ink-500">
                        {" "}
                        · {e.notebook} → {e.page}
                        {e.author ? ` · ${e.author}` : ""} · {formatDateTime(e.createdAt, timeZone)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
