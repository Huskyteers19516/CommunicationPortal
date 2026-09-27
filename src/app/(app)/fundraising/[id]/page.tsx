import { CalendarDays, ExternalLink, MapPin, Pencil, Trash2, UserRound } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FundraiserKindBadge, FundraiserStatusBadge, FundsBar } from "@/components/fundraising/fundraiser-badges";
import { FundraiserForm } from "@/components/fundraising/fundraiser-form";
import { HelpersCard } from "@/components/fundraising/helpers-card";
import { RaisedAmountForm } from "@/components/fundraising/raised-amount-form";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { RichText } from "@/components/ui/rich-text";
import { FUNDRAISER_KIND_LABELS } from "@/lib/constants";
import { type DateOnly, timeAgo, todayInTimezone } from "@/lib/dates";
import { fundraiserDateBounds, fundraiserDatesLabel, goalPercent } from "@/lib/fundraising";
import { formatDollars } from "@/lib/money";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { type FundraiserDetail, getFundraiser, getFundraiserLeadOptions } from "@/server/queries/fundraising";
import { deleteFundraiserAction, updateFundraiserAction } from "../actions";

export const metadata: Metadata = { title: "Fundraiser" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Request time, read outside of render so relative labels line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

/** Every ACTIVE person can open a fundraiser; the Business team and leaders also edit it here (`?edit=1`). */
export default async function FundraiserPage({ params, searchParams }: PageProps<"/fundraising/[id]">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const sp = await searchParams;
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone, now);
  const f = await getFundraiser(actor, id, { today });
  if (!f) notFound();

  if (first(sp.edit) === "1" && f.canManage) return <EditFundraiser f={f} today={today} />;

  const flash = first(sp.added) === "1" ? "Added. The whole team can see it now." : first(sp.saved) === "1" ? "Changes saved." : null;
  const dates = fundraiserDatesLabel(f, today);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <BackLink href="/fundraising">Fundraising</BackLink>
      {flash && (
        <div className="mb-4">
          <FocusAlert tone="success">{flash}</FocusAlert>
        </div>
      )}
      <PageHeader
        title={<span className="wrap-anywhere">{f.name}</span>}
        description={`${FUNDRAISER_KIND_LABELS[f.kind]} fundraiser`}
        actions={
          f.canManage && (
            <>
              <ButtonLink href={`/fundraising/${f.id}?edit=1`} variant="secondary">
                <Pencil className="size-4" aria-hidden />
                Edit
              </ButtonLink>
              <ActionForm
                action={deleteFundraiserAction}
                fields={{ fundraiserId: f.id }}
                variant="secondary"
                confirm={`Remove “${f.name}”? Its helper list goes too.`}
                pendingText="Removing…"
                aria-label={`Remove ${f.name}`}
              >
                <Trash2 className="size-4 text-red-600" aria-hidden />
                Remove
              </ActionForm>
            </>
          )
        }
      />

      <div className="-mt-3 mb-6 flex flex-wrap gap-1.5">
        <FundraiserStatusBadge status={f.status} datesPassed={f.datesPassed} />
        <FundraiserKindBadge kind={f.kind} />
        {f.isVolunteer && <Badge tone="brand">You&apos;re helping</Badge>}
        {f.isLead && <Badge tone="purple">You&apos;re leading</Badge>}
      </div>

      <div className="space-y-4">
        <Card>
          <CardBody className="space-y-4">
            <dl className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <dt className="flex shrink-0 items-center gap-1.5 text-ink-500">
                  <CalendarDays className="size-4" aria-hidden />
                  <span className="sr-only">When</span>
                </dt>
                <dd className="min-w-0 text-ink-800">{dates ?? "No dates yet"}</dd>
              </div>
              <div className="flex items-start gap-2">
                <dt className="flex shrink-0 items-center gap-1.5 text-ink-500">
                  <MapPin className="size-4" aria-hidden />
                  <span className="sr-only">Where</span>
                </dt>
                <dd className="min-w-0 text-ink-800 wrap-anywhere">{f.location || "No location yet"}</dd>
              </div>
              <div className="flex items-start gap-2">
                <dt className="flex shrink-0 items-center gap-1.5 text-ink-500">
                  <UserRound className="size-4" aria-hidden />
                  <span className="sr-only">Who&apos;s leading it</span>
                </dt>
                <dd className="min-w-0 text-ink-800 wrap-anywhere">
                  {f.lead ? <>Led by {f.isLead ? "you" : f.lead.name}</> : "No one is leading it yet"}
                </dd>
              </div>
            </dl>
            {f.link && (
              <a href={f.link} target="_blank" rel="noopener noreferrer nofollow" className={buttonClasses("secondary", "md")}>
                <ExternalLink className="size-4 shrink-0" aria-hidden />
                Open link
                <span className="sr-only"> for {f.name} (opens in a new tab)</span>
              </a>
            )}
            {f.description ? (
              <RichText text={f.description} className="text-sm text-ink-800 wrap-anywhere" />
            ) : (
              <p className="text-sm text-ink-500">No details yet.</p>
            )}
            <p className="text-xs text-ink-500 wrap-anywhere">
              Added {timeAgo(new Date(f.createdAt), now, timeZone)}
              {f.createdBy && <> by {f.createdBy.id === actor.id ? "you" : f.createdBy.name}</>}
            </p>
          </CardBody>
        </Card>

        <MoneyCard f={f} />

        <HelpersCard fundraiser={f} nowIso={now.toISOString()} timeZone={timeZone} />
      </div>
    </div>
  );
}

function MoneyCard({ f }: { f: FundraiserDetail }) {
  return (
    <Card>
      <CardHeader title="Money raised" />
      <CardBody className="space-y-4">
        <div className="space-y-2">
          <p className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-display text-2xl font-semibold tabular-nums text-ink-900">
              {formatDollars(f.raisedAmount)}
              {f.goalAmount !== null && <span className="text-ink-500"> of {formatDollars(f.goalAmount)}</span>}
            </span>
            {f.goalAmount !== null && (
              <span className="text-sm font-medium tabular-nums text-brand-700">
                {f.raisedAmount >= f.goalAmount ? "Goal reached!" : `${goalPercent(f.raisedAmount, f.goalAmount)}%`}
              </span>
            )}
          </p>
          {f.goalAmount !== null ? (
            <FundsBar raised={f.raisedAmount} goal={f.goalAmount} label={`Raised for ${f.name}`} size="lg" />
          ) : (
            <p className="text-sm text-ink-500">No goal set.</p>
          )}
        </div>
        {f.canManage && <RaisedAmountForm fundraiserId={f.id} raised={f.raisedAmount} />}
      </CardBody>
    </Card>
  );
}

/** The earliest / latest of some dates ("YYYY-MM-DD" sorts as text). */
function earliest(...dates: (string | null)[]): string {
  return dates.filter((d): d is string => !!d).sort()[0];
}
function latest(...dates: (string | null)[]): string {
  return dates.filter((d): d is string => !!d).sort().at(-1)!;
}

async function EditFundraiser({ f, today }: { f: FundraiserDetail; today: DateOnly }) {
  const leadGroups = await getFundraiserLeadOptions();
  const listed = f.lead && leadGroups.some((g) => g.options.some((o) => o.id === f.lead!.id));
  // The dates it has now stay pickable even when they're outside the usual range.
  const bounds = fundraiserDateBounds(today);
  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href={`/fundraising/${f.id}`}>Back to the fundraiser</BackLink>
      <PageHeader title="Edit fundraiser" description={<span className="wrap-anywhere">{f.name}</span>} />
      <FundraiserForm
        action={updateFundraiserAction}
        leadGroups={leadGroups}
        currentLead={f.lead && !listed ? f.lead : null}
        submitLabel="Save changes"
        cancelHref={`/fundraising/${f.id}`}
        minDate={earliest(bounds.min, f.startsOn, f.endsOn)}
        maxDate={latest(bounds.max, f.startsOn, f.endsOn)}
        initial={{
          id: f.id,
          name: f.name,
          kind: f.kind,
          status: f.status,
          description: f.description,
          location: f.location,
          link: f.link,
          startsOn: f.startsOn ?? "",
          endsOn: f.endsOn ?? "",
          goalAmount: f.goalAmount === null ? "" : String(f.goalAmount),
          raisedAmount: String(f.raisedAmount),
          leadId: f.lead?.id ?? "",
          volunteerLimit: f.volunteerLimit === null ? "" : String(f.volunteerLimit),
        }}
      />
    </div>
  );
}
