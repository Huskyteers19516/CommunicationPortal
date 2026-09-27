"use client";

import { ExternalLink, TriangleAlert, Upload } from "lucide-react";
import { useActionState, useDeferredValue, useMemo, useRef, useState } from "react";
import { importSponsorshipsAction } from "@/app/(app)/sponsors/actions";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, Field, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import type { DateOnly } from "@/lib/dates";
import { formatDollars } from "@/lib/money";
import {
  describeImportValue,
  type ExistingSponsor,
  existingValue,
  IMPORT_FIELD_LABELS,
  matchSponsorshipImport,
  type PlannedSponsorship,
  prepareSponsorshipImport,
  sheetValue,
  SPONSORSHIP_IMPORT_MAX_COLUMNS,
  SPONSORSHIP_IMPORT_MAX_PASTED_ROWS,
  SPONSORSHIP_IMPORT_MAX_ROWS,
  SPONSORSHIP_IMPORT_TEXT_MAX,
  type SponsorshipImportPlan,
} from "@/lib/sponsorship-import";
import { formatShortDate, type OwnerOption, websiteHost } from "@/lib/sponsorships";
import { StageBadge } from "./stage-badge";

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function listRows(rows: number[]): string {
  const shown = rows.slice(0, 8).join(", ");
  return rows.length > 8 ? `${shown}…` : shown;
}

/** "Import 3 sponsors" / "Update 2 sponsors" / "Import 3, update 2". */
function importLabel(plan: SponsorshipImportPlan | null): string {
  if (!plan || plan.toAdd + plan.toUpdate === 0) return "Import";
  if (plan.toUpdate === 0) return `Import ${plural(plan.toAdd, "sponsor")}`;
  if (plan.toAdd === 0) return `Update ${plural(plan.toUpdate, "sponsor")}`;
  return `Import ${plan.toAdd}, update ${plan.toUpdate}`;
}

/**
 * Paste rows from the Business team's sheet, see exactly what will be added or updated (the same parser
 * and checks the server uses), then import. The server reads the text again and re-checks everything.
 */
export function SponsorshipImportForm({
  today,
  owners,
  existing,
}: {
  today: DateOnly;
  owners: OwnerOption[];
  existing: ExistingSponsor[];
}) {
  const [state, formAction] = useActionState(importSponsorshipsAction, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(state, formRef);
  // The paste box and checkboxes stay uncontrolled (so React's reset after a submit puts back what's
  // here: defaultValue follows the state), and the state feeds the live preview.
  const [text, setText] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [updateExisting, setUpdateExisting] = useState(false);
  const deferredText = useDeferredValue(text);
  // Reading the paste doesn't depend on the checkboxes, so ticking one doesn't read it again.
  const prepared = useMemo(
    () => (deferredText.trim() ? prepareSponsorshipImport(deferredText, { today, owners }) : null),
    [deferredText, today, owners],
  );
  const updating = skipDuplicates && updateExisting;
  const plan = useMemo(
    () => (prepared ? matchSponsorshipImport(prepared, { existing, skipDuplicates, updateExisting: updating }) : null),
    [prepared, existing, skipDuplicates, updating],
  );
  const canImport = !!plan && !plan.tooMany && plan.toAdd + plan.toUpdate > 0 && plan.rowsWithErrors === 0;
  const textError = state && !state.ok ? state.fieldErrors?.text : undefined;

  return (
    <form ref={formRef} action={formAction} className="space-y-5">
      <FormMessage state={state && !state.ok && !textError ? state : null} />
      <Card>
        <CardBody className="space-y-4">
          <Field
            label="Paste rows from your spreadsheet"
            htmlFor="text"
            error={textError}
            hint="In Google Sheets, select the rows (include the header row if you can), copy with Ctrl+C (⌘C on a Mac), and paste here. Links on company names don't copy, so add websites afterwards."
          >
            <Textarea
              id="text"
              name="text"
              rows={8}
              maxLength={SPONSORSHIP_IMPORT_TEXT_MAX}
              spellCheck={false}
              invalid={!!textError}
              aria-describedby={textError ? "text-error" : undefined}
              defaultValue={text}
              onChange={(e) => setText(e.currentTarget.value)}
              className="font-mono text-xs sm:text-sm"
              placeholder={"AMOUNT RECEIVED\tCOMPLETION STAGE\tBRAND/COMPANY\tEmail\t…\n$500\tAccepted\tREV Robotics\tsponsors@…"}
            />
          </Field>
          <div className="space-y-3">
            <CheckboxField
              name="skipDuplicates"
              label="Don't add sponsors that are already here (same name)"
              description="Handy when you paste the whole sheet again."
              defaultChecked={skipDuplicates}
              onChange={(e) => setSkipDuplicates(e.currentTarget.checked)}
            />
            {skipDuplicates && (
              <CheckboxField
                name="updateExisting"
                label="Update sponsors that are already here"
                description="Copies their stage, amount, dates, and contact info from the sheet. Empty cells never erase anything."
                defaultChecked={updateExisting}
                onChange={(e) => setUpdateExisting(e.currentTarget.checked)}
                className="sm:pl-7"
              />
            )}
          </div>
        </CardBody>
      </Card>

      {plan && <ImportPreview plan={plan} today={today} updating={updating} skipDuplicates={skipDuplicates} />}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <ButtonLink href="/sponsors" variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingText="Importing…" disabled={!canImport}>
          <Upload className="size-4" aria-hidden />
          {importLabel(plan)}
        </SubmitButton>
      </div>
    </form>
  );
}

/** How the pasted columns are read: "DATE ANNOUNCED → Accepted on", plus the columns that aren't imported. */
function ColumnMapping({ plan }: { plan: SponsorshipImportPlan }) {
  const mapped = plan.columns.flatMap((field, i) => {
    if (!field) return [];
    const header = plan.hasHeader ? plan.headers[i] : `Column ${i + 1}`;
    return [{ i, header, label: IMPORT_FIELD_LABELS[field] }];
  });
  const ignored = plan.hasHeader ? plan.columns.flatMap((field, i) => (!field && plan.headers[i] ? [plan.headers[i]] : [])) : [];
  return (
    <div className="space-y-1.5 text-sm text-ink-600">
      <p>
        {plan.hasHeader
          ? "Columns from your header row:"
          : mapped.length === 1
            ? "One column, read as sponsor names:"
            : "No header row, so the columns are read in the Business sheet's order:"}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {mapped.map((m) => (
          <li key={m.i} className="min-w-0 wrap-anywhere">
            <span className="font-medium text-ink-800">{m.header}</span>
            <span aria-hidden> → </span>
            <span className="sr-only"> is read as </span>
            {m.label}
          </li>
        ))}
      </ul>
      {ignored.length > 0 && (
        <p className="wrap-anywhere">
          <span className="font-medium text-ink-700">Not imported:</span> {ignored.join(", ")}
        </p>
      )}
      {!plan.hasHeader && mapped.length > 1 && <p>Paste the header row too if your columns are different.</p>}
      {plan.extraColumns && <p>Only the first {SPONSORSHIP_IMPORT_MAX_COLUMNS} columns are read; the rest are ignored.</p>}
    </div>
  );
}

function ImportPreview({
  plan,
  today,
  updating,
  skipDuplicates,
}: {
  plan: SponsorshipImportPlan;
  today: DateOnly;
  updating: boolean;
  skipDuplicates: boolean;
}) {
  const saved = (r: PlannedSponsorship) => !r.duplicate || r.update;
  const warnings = plan.rows.reduce((n, r) => n + (saved(r) ? r.warnings.length : 0), 0);
  const summary = [
    plan.toAdd > 0 ? `${plural(plan.toAdd, "sponsor")} to import` : "Nothing new to import",
    plan.toUpdate > 0 && `${plan.toUpdate} to update`,
    plan.duplicates > 0 && `${plan.duplicates} already here (skipped)`,
    warnings > 0 && plural(warnings, "warning"),
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = plan.rows.slice(0, SPONSORSHIP_IMPORT_MAX_ROWS);

  return (
    <Card>
      <CardHeader title="Preview" description={<span role="status">{summary}</span>} />
      <CardBody className="space-y-3">
        {plan.tooManyRows ? (
          <Alert tone="error">
            That&apos;s more than {SPONSORSHIP_IMPORT_MAX_PASTED_ROWS.toLocaleString("en-US")} rows. Paste up to{" "}
            {SPONSORSHIP_IMPORT_MAX_PASTED_ROWS.toLocaleString("en-US")} at a time.
          </Alert>
        ) : (
          plan.tooMany && (
            <Alert tone="error">
              That&apos;s {plan.toAdd + plan.toUpdate} sponsors to {plan.toUpdate > 0 ? "add or update" : "add"}. Import up to{" "}
              {SPONSORSHIP_IMPORT_MAX_ROWS} at a time.
            </Alert>
          )
        )}
        {plan.rowsWithErrors > 0 && (
          <Alert tone="error">
            {plural(plan.rowsWithErrors, "row")} {plan.rowsWithErrors === 1 ? "needs" : "need"} fixing before you can import. Fix{" "}
            {plan.rowsWithErrors === 1 ? "it" : "them"} in the sheet and paste again.
          </Alert>
        )}
        {!updating && skipDuplicates && plan.outdated > 0 && (
          <Alert tone="info">
            {plural(plan.outdated, "sponsor")} already here {plan.outdated === 1 ? "has" : "have"} different info in the sheet. Check
            “Update sponsors that are already here” to copy it over.
          </Alert>
        )}
        <ColumnMapping plan={plan} />
        {plan.unnamedRows.length > 0 && (
          <p className="text-sm text-amber-800">
            {plan.unnamedRows.length === 1 ? "Row" : "Rows"} {listRows(plan.unnamedRows)} {plan.unnamedRows.length === 1 ? "has" : "have"} no
            sponsor name, so {plan.unnamedRows.length === 1 ? "it's" : "they're"} skipped.
          </p>
        )}
      </CardBody>
      {shown.length > 0 && (
        <>
          {/* Phones */}
          <ul className="divide-y divide-ink-100 border-t border-ink-100 md:hidden">
            {shown.map((r) => (
              <li key={r.row} className={cn("space-y-1.5 px-4 py-3", r.duplicate && !r.update && "bg-ink-50/60")}>
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 font-medium text-ink-900 wrap-anywhere">
                    <span className="mr-1.5 text-xs font-normal text-ink-500">Row {r.row}</span>
                    {r.name}
                  </p>
                  <RowBadge row={r} />
                </div>
                <RowContact row={r} />
                <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-600">
                  {r.amountReceived !== null && <span>Received {formatDollars(r.amountReceived)}</span>}
                  {r.owner && <span className="wrap-anywhere">{r.owner.name}</span>}
                  <RowDates row={r} today={today} />
                </p>
                <RowProblems row={r} today={today} updating={updating} />
              </li>
            ))}
          </ul>

          {/* Tablets and up */}
          <table className="hidden w-full table-fixed border-t border-ink-100 text-left text-sm md:table">
            <thead className="border-b border-ink-100 bg-ink-50/60 text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="w-14 px-3 py-2 font-medium lg:px-4">
                  Row
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Sponsor
                </th>
                <th scope="col" className="w-32 px-2 py-2 font-medium">
                  Stage
                </th>
                <th scope="col" className="w-24 px-2 py-2 text-right font-medium">
                  Received
                </th>
                <th scope="col" className="w-32 px-2 py-2 font-medium">
                  Person
                </th>
                <th scope="col" className="w-44 px-2 py-2 font-medium lg:pr-4">
                  Dates
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {shown.map((r) => (
                <tr key={r.row} className={cn("align-top", r.duplicate && !r.update && "bg-ink-50/60 text-ink-600")}>
                  <td className="px-3 py-2 text-xs text-ink-500 lg:px-4">{r.row}</td>
                  <td className="min-w-0 px-2 py-2">
                    <p className="font-medium text-ink-900 wrap-anywhere">{r.name}</p>
                    <RowContact row={r} truncate />
                    <RowProblems row={r} today={today} updating={updating} className="mt-1" />
                  </td>
                  <td className="px-2 py-2">
                    <RowBadge row={r} />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {r.amountReceived !== null ? formatDollars(r.amountReceived) : <span className="text-ink-500">—</span>}
                  </td>
                  <td className="truncate px-2 py-2">{r.owner ? r.owner.name : <span className="text-ink-500">—</span>}</td>
                  <td className="px-2 py-2 text-xs text-ink-600 lg:pr-4">
                    <span className="flex flex-col">
                      <RowDates row={r} today={today} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

function RowBadge({ row }: { row: PlannedSponsorship }) {
  if (row.update) return <Badge tone="blue">Update</Badge>;
  if (row.duplicate) return <Badge>Already here</Badge>;
  return <StageBadge stage={row.stage} />;
}

/** The row's website and email (what gets saved). */
function RowContact({ row, truncate = false }: { row: PlannedSponsorship; truncate?: boolean }) {
  const parts = [row.website && (websiteHost(row.website) || row.website), row.contactEmail].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className={cn("text-xs text-ink-500", truncate ? "truncate" : "wrap-anywhere")}>{parts.join(" · ")}</p>;
}

function RowDates({ row, today }: { row: PlannedSponsorship; today: DateOnly }) {
  const dates = [
    row.submittedOn && `Submitted ${formatShortDate(row.submittedOn, today)}`,
    row.acceptedOn && `Accepted ${formatShortDate(row.acceptedOn, today)}`,
    row.closesOn && `Closes ${formatShortDate(row.closesOn, today)}`,
  ].filter((d): d is string => !!d);
  if (dates.length === 0) return <span className="text-ink-500">No dates</span>;
  return (
    <>
      {dates.map((d) => (
        <span key={d}>{d}</span>
      ))}
    </>
  );
}

/** "Sheet: Accepted · $1,000 — here: Needs work · no amount" for a sponsor that's already here. */
function RowDifference({ row, today }: { row: PlannedSponsorship; today: DateOnly }) {
  const existing = row.existing;
  if (!existing || row.changes.length === 0) return null;
  const sheet = row.changes.map((f) => describeImportValue(f, sheetValue(row, f), today)).join(" · ");
  const here = row.changes.map((f) => describeImportValue(f, existingValue(existing, f), today)).join(" · ");
  return (
    <>
      <span className="wrap-anywhere">
        Sheet: {sheet} — here: {here}.
      </span>{" "}
      <a
        href={`/sponsors/${encodeURIComponent(existing.id)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-10 items-center gap-1 font-medium text-brand-700 underline-offset-2 hover:underline md:min-h-0"
      >
        Open {existing.name}
        <ExternalLink className="size-3 shrink-0" aria-hidden />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </>
  );
}

function RowProblems({
  row,
  today,
  updating,
  className,
}: {
  row: PlannedSponsorship;
  today: DateOnly;
  updating: boolean;
  className?: string;
}) {
  if (row.duplicate && !row.update) {
    const why = row.repeated
      ? "This name is earlier in the paste, so it's skipped."
      : row.sameNameHere > 1
        ? `There are ${row.sameNameHere} sponsors named “${row.name}” here, so it's skipped${updating ? " and none of them is updated" : ""}.`
        : row.changes.length === 0
          ? "Already here, with the same info. Skipped."
          : "Already here, so it's skipped.";
    return (
      <p className={cn("text-xs text-ink-600", className)}>
        {why} {!row.repeated && <RowDifference row={row} today={today} />}
      </p>
    );
  }
  if (row.errors.length === 0 && row.warnings.length === 0 && !row.update) return null;
  return (
    <div className={cn("space-y-0.5 text-xs", className)}>
      {row.update && (
        <p className="text-sky-800">
          Will be updated. <RowDifference row={row} today={today} />
        </p>
      )}
      {(row.errors.length > 0 || row.warnings.length > 0) && (
        <ul className="space-y-0.5">
          {row.errors.map((e, i) => (
            <li key={`e${i}`} className="flex gap-1.5 font-medium text-red-700">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 wrap-anywhere">{e}</span>
            </li>
          ))}
          {row.warnings.map((w, i) => (
            <li key={`w${i}`} className="flex gap-1.5 text-amber-800">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 wrap-anywhere">{w}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
