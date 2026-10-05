import { BadgeDollarSign, CalendarClock, CircleCheck, FileSpreadsheet, HandCoins, Hourglass, Plus, SearchX } from "lucide-react";
import type { Metadata } from "next";
import { KeepChipInView } from "@/components/discussion/keep-chip-in-view";
import { BulkSelectToggle, SponsorBulkRemove } from "@/components/sponsors/bulk-remove";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { NoSponsorshipAccess } from "@/components/sponsors/no-access";
import { SponsorshipInfoCard } from "@/components/sponsors/sponsorship-info-card";
import { type SponsorHighlight, SponsorshipList } from "@/components/sponsors/sponsorship-list";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { LIMITS } from "@/lib/constants";
import { timeAgo, todayInTimezone } from "@/lib/dates";
import { formatDollars, formatDollarsCompact } from "@/lib/money";
import { parseSponsorshipFilter, SPONSORSHIP_FILTER_KEYS, SPONSORSHIP_FILTERS, type SponsorshipFilter } from "@/lib/sponsorships";
import { env } from "@/server/env";
import { getSponsorshipInfo, listSponsorships, sponsorshipExists } from "@/server/queries/sponsorships";
import { getSponsorshipUser } from "./access";

export const metadata: Metadata = { title: "Sponsorships" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function hrefFor(filter: SponsorshipFilter, mine: boolean): string {
  const sp = new URLSearchParams();
  if (filter !== "all") sp.set("filter", filter);
  if (mine) sp.set("mine", "1");
  const qs = sp.toString();
  return qs ? `/sponsors?${qs}` : "/sponsors";
}

/** "?imported=3&skipped=1" after an import → a whole number, or null. */
function count(v: string | string[] | undefined): number | null {
  const s = first(v);
  return s && /^\d{1,4}$/.test(s) ? Number(s) : null;
}

function importedMessage(added: number, updated: number, skipped: number): string {
  return [
    added > 0 ? `Imported ${added} ${added === 1 ? "sponsor" : "sponsors"}.` : updated === 0 ? "No new sponsors to add." : null,
    updated > 0 && `Updated ${updated} ${updated === 1 ? "sponsor that was" : "sponsors that were"} already here.`,
    skipped > 0 && `Skipped ${skipped} that ${skipped === 1 ? "was" : "were"} already here.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** What an empty filtered list means. */
function emptyText(filter: SponsorshipFilter, mine: boolean): string {
  const texts: Record<SponsorshipFilter, [all: string, mine: string]> = {
    all: ["No sponsors yet.", "You're not the person on any sponsors yet."],
    todo: ["Nothing left to start or finish. Nice work!", "Nothing for you to start or finish right now."],
    closing: ["No deadlines in the next 2 weeks.", "None of yours close in the next 2 weeks."],
    submitted: ["Nothing is waiting to hear back.", "None of yours are waiting to hear back."],
    accepted: ["No accepted sponsors yet.", "None of yours have been accepted yet."],
    finished: ["No finished sponsors yet.", "None of yours are finished yet."],
    declined: ["No declined sponsors.", "None of yours were declined."],
    logo: ["Every sponsor on the team website has a logo.", "None of yours need a logo."],
  };
  return texts[filter][mine ? 1 : 0];
}

/**
 * After adding or saving a sponsor ("?added=<id>" / "?saved=<id>"): that row is highlighted and focused,
 * with a note (and whether another sponsor already had the name). A new sponsor's note links to its page to
 * attach forms and files. Null when it isn't in the list shown.
 */
function highlightFor(sp: Record<string, string | string[] | undefined>, items: { id: string; name: string }[]): SponsorHighlight | null {
  const added = first(sp.added);
  const id = added ?? first(sp.saved);
  const item = id ? items.find((i) => i.id === id) : undefined;
  if (!item) return null;
  if (!added) return { id: item.id, tone: "success", message: "Changes saved." };
  if (first(sp.same) === "1") {
    return {
      id: item.id,
      tone: "warning",
      message: `Added. You already had a sponsor named ${item.name} — both are kept.`,
      attachFiles: true,
    };
  }
  return { id: item.id, tone: "success", message: "Added just now.", attachFiles: true };
}

export default async function SponsorshipsPage({ searchParams }: PageProps<"/sponsors">) {
  const actor = await getSponsorshipUser();
  if (!actor) return <NoSponsorshipAccess />;
  const sp = await searchParams;
  const filter = parseSponsorshipFilter(sp.filter);
  const mine = first(sp.mine) === "1";
  const today = todayInTimezone(env.teamTimezone);
  const [list, info] = await Promise.all([listSponsorships(actor, { filter, mine, today }), getSponsorshipInfo(actor)]);
  if (!list || !info) return <NoSponsorshipAccess />;
  const { items, summary } = list;
  const imported = count(sp.imported);
  const updated = count(sp.updated) ?? 0;
  const skipped = count(sp.skipped) ?? 0;
  const removed = first(sp.removed)?.slice(0, LIMITS.sponsorNameMax);
  const highlight = highlightFor(sp, items);
  // Added or saved, but not in this list (it's cut off): say so at the top instead. Not once it's been removed
  // (e.g. with Select → Remove while the URL still says ?added=), which would announce it again.
  const flashId = first(sp.added) ?? first(sp.saved);
  const flashFallback =
    !highlight && flashId && (await sponsorshipExists(actor, flashId)) ? (first(sp.added) ? "Sponsor added." : "Changes saved.") : null;

  const addButton = (
    <ButtonLink href="/sponsors/new">
      <Plus className="size-4" aria-hidden />
      Add sponsor
    </ButtonLink>
  );
  const importButton = (
    <ButtonLink href="/sponsors/import" variant="secondary">
      <FileSpreadsheet className="size-4" aria-hidden />
      Import from a spreadsheet
    </ButtonLink>
  );
  const infoUpdated =
    info.updatedAt && info.body
      ? `Updated ${timeAgo(info.updatedAt, new Date(), env.teamTimezone)}${info.updatedByName ? ` by ${info.updatedByName}` : ""}`
      : null;

  return (
    <>
      <PageHeader
        title="Sponsorships"
        description="Every sponsor ask, from first email to money in the bank."
        actions={
          <>
            {addButton}
            {importButton}
          </>
        }
      />

      <div className="space-y-6">
        {imported !== null && <FocusAlert tone="success">{importedMessage(imported, updated, skipped)}</FocusAlert>}
        {removed && <FocusAlert tone="success">Removed “{removed}”.</FocusAlert>}
        {flashFallback && <FocusAlert tone="success">{flashFallback}</FocusAlert>}

        {summary.total > 0 && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Received"
              value={<span title={formatDollars(summary.totalReceived)}>{formatDollarsCompact(summary.totalReceived)}</span>}
              icon={BadgeDollarSign}
              hint={summary.paying > 0 ? `From ${summary.paying} ${summary.paying === 1 ? "sponsor" : "sponsors"}` : "Nothing yet"}
            />
            <StatCard label="Accepted" value={summary.counts.ACCEPTED} icon={CircleCheck} href={hrefFor("accepted", false)} />
            <StatCard label="Waiting to hear back" value={summary.waiting} icon={Hourglass} href={hrefFor("submitted", false)} />
            <StatCard
              label="Closing in 2 weeks"
              value={summary.closingSoon}
              icon={CalendarClock}
              href={hrefFor("closing", false)}
              tone={summary.closingSoon > 0 ? "attention" : "default"}
            />
          </div>
        )}

        <SponsorshipInfoCard body={info.body} updatedLabel={infoUpdated} />

        {/* Keyed by the filter like the list: a new filter starts a new selection. It also holds the "Removed 12
            sponsors." line, which stays when the list below empties. */}
        <SponsorBulkRemove
          key={`${filter}:${mine ? 1 : 0}`}
          items={items.map((i) => ({ id: i.id, name: i.name, canDelete: i.canDelete, fileCount: i.fileCount }))}
          canBulkRemove={list.canBulkRemove}
        >
          {summary.total === 0 ? (
            <Card>
              <EmptyState
                icon={HandCoins}
                title="No sponsors yet"
                description="Add your first sponsor, or import your spreadsheet."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {addButton}
                    {importButton}
                  </div>
                }
              />
            </Card>
          ) : (
            <section aria-labelledby="sponsor-list-heading" className="space-y-3">
              <h2 id="sponsor-list-heading" className="sr-only">
                Sponsors
              </h2>
              {/* Flex gaps, not space-y: KeepChipInView adds no box of its own. */}
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                {/* The strip is wider than the screen on phones (and on laptops with "Logo needed"): scroll the active
                    chip into view, e.g. after Today's "N sponsors need a logo" link. */}
                <KeepChipInView active={filter}>
                  <FilterChips
                    label="Filter by stage"
                    className="md:min-w-0 md:flex-1"
                    chips={SPONSORSHIP_FILTER_KEYS.filter((key) => key !== "logo" || summary.logoNeeded > 0 || filter === "logo").map((key) => ({
                      href: hrefFor(key, mine),
                      // "Logo needed" only while some do (or it's the filter picked), with how many.
                      label: key === "logo" ? `${SPONSORSHIP_FILTERS[key].label} (${summary.logoNeeded})` : SPONSORSHIP_FILTERS[key].label,
                      active: filter === key,
                    }))}
                  />
                </KeepChipInView>
                <div className="flex items-center gap-2">
                  <ToggleChip href={hrefFor(filter, !mine)} label="Mine" active={mine} />
                  <BulkSelectToggle className="ml-auto md:ml-0" />
                </div>
              </div>

              {list.truncated && <Alert>Showing the first {items.length} sponsors. Pick a filter to see the rest.</Alert>}

              {items.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={SearchX}
                    title="Nothing here"
                    description={emptyText(filter, mine)}
                    action={
                      <ButtonLink href={hrefFor("all", false)} variant="secondary">
                        Show all sponsors
                      </ButtonLink>
                    }
                  />
                </Card>
              ) : (
                // Keyed by the filter: the list keeps its order while stages change here, and re-sorts on a new filter.
                <SponsorshipList key={`${filter}:${mine ? 1 : 0}`} items={items} today={today} highlight={highlight} />
              )}
            </section>
          )}
        </SponsorBulkRemove>
      </div>
    </>
  );
}
