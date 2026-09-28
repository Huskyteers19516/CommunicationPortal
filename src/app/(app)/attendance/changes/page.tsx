import { Download, History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChangeCount, ChangeFilterForm } from "@/components/attendance/change-filters";
import { BackLink } from "@/components/tasks/back-link";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { formatDateTime, todayInTimezone } from "@/lib/dates";
import {
  ATTENDANCE_CHANGE_KIND_LABELS,
  ATTENDANCE_CHANGE_KINDS,
  type AttendanceChangeFilters,
  type AttendanceChangeKind,
  attendanceChangeQuery,
  changeKindOf,
  describeAttendanceChange,
  hasAttendanceChangeFilters,
  parseAttendanceChangeFilters,
} from "@/server/attendance/changes";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canViewAttendanceChanges } from "@/server/permissions";
import { type ChangeFilterChoices, getChangeFilterChoices, listAttendanceChanges } from "@/server/queries/attendance-changes";

export const metadata: Metadata = { title: "Attendance changes" };

const KIND_TONES: Record<AttendanceChangeKind, BadgeTone> = {
  ADDED: "green",
  NOT_HERE: "red",
  REMOVED: "red",
  CREDIT_CHANGED: "yellow",
  SCANNED_IN: "blue",
  SESSION_DELETED: "gray",
};

/**
 * A GET form, so the filters live in the address (shareable, back button, works without JS): picking from a menu
 * applies it right away; Filter sends the dates. Each menu has a visible label (Person and Changed by list the same
 * names).
 */
function ChangeFilters({ filters, choices }: { filters: AttendanceChangeFilters; choices: ChangeFilterChoices }) {
  return (
    <ChangeFilterForm action="/attendance/changes">
      {/* One column on phones so the names in the menus aren't cut off. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Person" htmlFor="changes-person">
          <AutoSubmitSelect id="changes-person" name="person" defaultValue={filters.person ?? ""}>
            <option value="">Anyone</option>
            {choices.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </AutoSubmitSelect>
        </Field>
        <Field label="Changed by" htmlFor="changes-by">
          <AutoSubmitSelect id="changes-by" name="by" defaultValue={filters.by ?? ""}>
            <option value="">Anyone</option>
            {choices.admins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </AutoSubmitSelect>
        </Field>
        <Field label="Kind of change" htmlFor="changes-action" className="sm:col-span-2 lg:col-span-1">
          <AutoSubmitSelect id="changes-action" name="action" defaultValue={filters.action ?? ""}>
            <option value="">Any kind</option>
            {ATTENDANCE_CHANGE_KINDS.map((a) => (
              <option key={a} value={a}>
                {ATTENDANCE_CHANGE_KIND_LABELS[a]}
              </option>
            ))}
          </AutoSubmitSelect>
        </Field>
      </div>
      <div className="grid grid-cols-1 items-end gap-2 min-[360px]:grid-cols-2 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Attendance from" htmlFor="changes-from">
          <Input id="changes-from" type="date" name="from" defaultValue={filters.from ?? ""} />
        </Field>
        <Field label="Attendance to" htmlFor="changes-to">
          <Input id="changes-to" type="date" name="to" defaultValue={filters.to ?? ""} />
        </Field>
        <Button type="submit" variant="secondary" className="min-[360px]:col-span-2 sm:col-span-1">
          Filter
        </Button>
      </div>
    </ChangeFilterForm>
  );
}

/**
 * Admins only (members get 404): every change admins made to people's attendance — added by hand, taken off, credit
 * changed, a session deleted — as sentences, newest first, with filters (person, who changed it, kind of change,
 * the attendance's days), pages of 50, and a CSV of everything matching the filters.
 */
export default async function AttendanceChangesPage({ searchParams }: PageProps<"/attendance/changes">) {
  const actor = await requireActiveUser();
  if (!canViewAttendanceChanges(actor)) notFound();
  const filters = parseAttendanceChangeFilters(await searchParams);
  const [result, choices] = await Promise.all([listAttendanceChanges(actor, filters), getChangeFilterChoices(actor)]);
  if (!result || !choices) notFound();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone);
  const filtered = hasAttendanceChangeFilters(filters);
  const query = attendanceChangeQuery(filters);

  return (
    <>
      <BackLink href="/attendance">Attendance</BackLink>
      <PageHeader
        title="Attendance changes"
        description="What admins changed: people added by hand, marked not here, taken off, credits changed, and sessions deleted (and people who scanned in over a hand entry). Only admins see this."
        actions={
          <a
            href={`/attendance/changes/csv${query}`}
            download
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-ink-200 bg-white px-4 text-sm font-medium text-ink-800 shadow-sm hover:bg-ink-50"
          >
            <Download className="size-4" aria-hidden />
            Download CSV
          </a>
        }
      />

      <div className="max-w-3xl space-y-4">
        {/* Keyed by the filters so "Clear filters" (a client navigation) resets the menus too. */}
        <ChangeFilters key={query} filters={filters} choices={choices} />

        <div className="flex flex-wrap items-center justify-between gap-x-3 text-sm text-ink-500">
          <ChangeCount query={query} className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50">
            {result.total} {result.total === 1 ? "change" : "changes"}
            {filtered ? (result.total === 1 ? " matches" : " match") : ""}
          </ChangeCount>
          {filtered && (
            <Link href="/attendance/changes" className="inline-flex min-h-10 items-center font-medium text-brand-700 hover:underline">
              Clear filters
            </Link>
          )}
        </div>

        {result.rows.length === 0 ? (
          <Card>
            <EmptyState
              icon={History}
              title={filtered ? "No changes match these filters." : "No changes yet."}
              description={
                filtered
                  ? "Try other filters or clear them."
                  : "When an admin adds someone by hand, takes them off, or changes a credit, it shows up here."
              }
            />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-ink-100" aria-label="Attendance changes">
              {result.rows.map((c) => (
                <li key={c.id} className="space-y-1 px-4 py-3 text-sm sm:px-5">
                  <p className="text-ink-900 wrap-anywhere">{describeAttendanceChange(c, today)}</p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                    <Badge tone={KIND_TONES[changeKindOf(c)]}>{ATTENDANCE_CHANGE_KIND_LABELS[changeKindOf(c)]}</Badge>
                    <span>{formatDateTime(c.createdAt, timeZone)}</span>
                    {c.sessionId && (
                      <Link
                        href={`/attendance/sessions/${c.sessionId}`}
                        className="inline-flex min-h-10 items-center font-medium text-brand-700 hover:underline"
                      >
                        Open the session
                      </Link>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Pagination page={result.page} pageCount={result.pageCount} hrefFor={(p) => `/attendance/changes${attendanceChangeQuery(filters, p)}`} />
      </div>
    </>
  );
}
