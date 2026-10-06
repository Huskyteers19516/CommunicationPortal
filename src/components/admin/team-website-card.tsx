"use client";

import { ExternalLink, Globe } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { updatePublicProgressSettingsAction } from "@/app/(app)/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, Field, Select, Input } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { addDays, type DateOnly, formatDateOnly } from "@/lib/dates";
import { PUBLIC_EVENTS_PATH, PUBLIC_SPONSORS_PATH, PUBLIC_TEAM_PHOTOS_PATH, PUBLIC_WORKSHOP_PATH } from "@/lib/public-api";
import { PUBLIC_EVENT_KINDS_SENTENCE } from "@/lib/public-events";
import {
  NAME_STYLE_LABELS,
  NAME_STYLES,
  PUBLIC_HIDDEN_MIN_GROUP,
  PUBLIC_PROGRESS_PATH,
  type PublicProgressSettings,
  TEAM_SITE_ORIGIN,
  TEAM_SITE_PROGRESS_URL,
} from "@/lib/public-progress";
import type { TeamWebsitePreview } from "@/server/queries/team-website";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Shown now: 7 sponsors (2 without a logo)." / "Off. Turning it on shows 7 sponsors … — check them in Sponsorships first." */
function sponsorsPreview(p: TeamWebsitePreview, on: boolean): string {
  const what = `${plural(p.sponsors, "sponsor", "sponsors")}${p.sponsorsWithoutLogo > 0 ? ` (${p.sponsorsWithoutLogo} without a logo)` : ""}`;
  return on ? `Shown now: ${what}.` : `Off. Turning it on shows ${what} — check them in Sponsorships first.`;
}

function eventsPreview(p: TeamWebsitePreview, on: boolean): string {
  const what = plural(p.events, "event", "events");
  return on ? `Shown now: ${what}.` : `Off. Turning it on shows ${what} — check their locations and links first.`;
}

function photosPreview(p: TeamWebsitePreview, on: boolean): string {
  const what = plural(p.photos, "person's photo", "people's photos");
  return on ? `Shown now: ${what}.` : `Off. Turning it on shows ${what}.`;
}

const linkClass =
  "inline-flex min-h-10 items-center gap-1.5 rounded-md text-sm font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/**
 * Admin → Approvals → Team website: what huskyteers19516.github.io shows from the portal — the progress page (on/off,
 * how names are shown, each person's profile on the Our Team page, task titles, where counting starts), the sponsors on
 * the Sponsors page, the Events page, and members' photos on the Our Team page (each on/off) — with links to the pages
 * and the live JSON, and how the Workshop page fills (projects go on it one at a time, once approved in the Workshop).
 * Everyone with admin access.
 */
export function TeamWebsiteCard({
  settings,
  defaultSince,
  hiddenPeople,
  hiddenUncounted,
  preview,
  today,
}: {
  settings: PublicProgressSettings;
  /** The attendance reports' start: used while "Count tasks due from" is empty. */
  defaultSince: DateOnly;
  /** People who turned off "Show me on the team website" (a count only). */
  hiddenPeople: number;
  /** Of them: left out of the totals too (too few hidden in their subteam). */
  hiddenUncounted: number;
  /** What the Sponsors and Events pages list (or would list once turned on): counts only. */
  preview: TeamWebsitePreview | null;
  today: DateOnly;
}) {
  const [state, formAction] = useActionState(updatePublicProgressSettingsAction, initialActionState);
  const failed = !!state && !state.ok;
  const values = failed ? (state.values ?? {}) : null;
  const fieldErrors = failed ? (state.fieldErrors ?? {}) : {};
  // Inputs remount with each answer: the saved settings after a save, what was sent after a refusal.
  const key = state?.nonce ?? 0;
  const enabled = values ? values.enabled === "on" : settings.enabled;
  const showTaskTitles = values ? values.showTaskTitles === "on" : settings.showTaskTitles;
  const nameStyle = values?.nameStyle ?? settings.nameStyle;
  const since = values ? (values.since ?? "") : (settings.since ?? "");
  const showSponsors = values ? values.showSponsors === "on" : settings.showSponsors;
  const showEvents = values ? values.showEvents === "on" : settings.showEvents;
  const showPersonPages = values ? values.showPersonPages === "on" : settings.showPersonPages;
  const showPhotos = values ? values.showPhotos === "on" : settings.showPhotos;

  return (
    <Card role="region" aria-label="Team website">
      <CardHeader
        title="Team website"
        description="Live progress, sponsors, events, Workshop projects, and members' photos for guests on the team's site — no sign-in."
        actions={
          // The progress page's switch (the main one); sponsors and events have their own boxes below.
          <Badge tone={settings.enabled ? "green" : "gray"} title={settings.enabled ? "Live progress is on" : "Live progress is off"}>
            {settings.enabled ? "On" : "Off"}
          </Badge>
        }
      />
      <CardBody className="space-y-4">
        <form action={formAction} className="space-y-4" noValidate>
          <CheckboxField
            key={`enabled-${key}`}
            name="enabled"
            defaultChecked={enabled}
            label="Show live progress on the team website"
            description="Off: the page says progress is private right now."
          />
          <Field
            label="Names"
            htmlFor="public-progress-names"
            error={fieldErrors.nameStyle}
            hint="Also how designers are credited on the Workshop page."
          >
            <Select
              key={`names-${key}`}
              id="public-progress-names"
              name="nameStyle"
              defaultValue={nameStyle}
              invalid={!!fieldErrors.nameStyle}
            >
              {NAME_STYLES.map((style) => (
                <option key={style} value={style}>
                  {NAME_STYLE_LABELS[style]}
                </option>
              ))}
            </Select>
          </Field>
          <CheckboxField
            key={`titles-${key}`}
            name="showTaskTitles"
            defaultChecked={showTaskTitles}
            label="Show task titles on the team website"
            description="In “Recent completions” on the progress page and in each person’s finished list on the Our Team page. Off: they show “Checklist item completed” (with the subteam, and the person when names are shown) or “A task” instead. Titles are public: keep names and sponsor details out of them."
          />
          <CheckboxField
            key={`profiles-${key}`}
            name="showPersonPages"
            defaultChecked={showPersonPages}
            label="Show each person’s profile on the Our Team page"
            description="Selecting someone on the website’s Our Team page then shows what they finished: their last 25 checklist items, when each was approved (to the minute), the task titles (when shown), which were counted because a leader marked the whole task finished, and their last 8 weeks. Off: their profile shows only their numbers from the progress page. Needs live progress on and names shown."
          />
          <Field
            label="Count tasks due from"
            htmlFor="public-progress-since"
            optional
            error={fieldErrors.since}
            hint={`Empty: from when attendance reports start (${formatDateOnly(defaultSince, today)}). The Events page lists events from this day on too.`}
          >
            <Input
              key={`since-${key}`}
              id="public-progress-since"
              name="since"
              type="date"
              min={addDays(today, -5 * 366)}
              max={addDays(today, 366)}
              defaultValue={since}
              invalid={!!fieldErrors.since}
              aria-describedby={fieldErrors.since ? "public-progress-since-error" : undefined}
              className="sm:max-w-48"
            />
          </Field>
          <div className="space-y-3 border-t border-ink-100 pt-4">
            <CheckboxField
              key={`sponsors-${key}`}
              name="showSponsors"
              defaultChecked={showSponsors}
              label="Thank our sponsors on the team website"
              description={
                <>
                  Accepted and finished sponsors (unless “Thank them on the team website” is off on one): name, logo,
                  website&apos;s homepage, and years. Never amounts, contacts, or notes.
                  {preview && <> {sponsorsPreview(preview, settings.showSponsors)}</>}
                </>
              }
            />
            <CheckboxField
              key={`events-${key}`}
              name="showEvents"
              defaultChecked={showEvents}
              label="List events on the team website"
              description={
                <>
                  The Team calendar&apos;s {PUBLIC_EVENT_KINDS_SENTENCE} from the day above on (unless one is hidden from
                  the website): title, days, times, location, and link. Never team meetings or notes.
                  {preview && <> {eventsPreview(preview, settings.showEvents)}</>}
                </>
              }
            />
            <CheckboxField
              key={`photos-${key}`}
              name="showPhotos"
              defaultChecked={showPhotos}
              label="Show members’ photos on the team website"
              description={
                <>
                  Each person&apos;s own photo from their Settings, next to their name wherever the website lists them
                  (their Our Team card, the progress page; matched by full name), unless they turned “Show my photo on
                  the team website” off or it&apos;s held off (a person&apos;s Photo card in People). The photos themselves are
                  public; the list the website reads names nobody (a fingerprint of each name instead), so it isn&apos;t
                  a list of who&apos;s on the team. Off: the website shows no member&apos;s photo.
                  {preview && <> {photosPreview(preview, settings.showPhotos)}</>}
                </>
              }
            />
          </div>
          <SubmitButton pendingText="Saving…" className="w-full sm:w-auto">
            Save
          </SubmitButton>
          <FormMessage state={state} />
        </form>

        <div className="space-y-2 border-t border-ink-100 pt-4 text-sm text-ink-600">
          <p>
            Guests see each person&apos;s name and position, how many checklist items they&apos;ve finished, have open, and
            have checked off for review, when their items were approved (to the minute), the task titles in Recent
            completions (when shown), and the subteams&apos; and team&apos;s totals. While profiles are on, selecting a
            listed person on the Our Team page also shows what they finished — their last 25 items with the task titles
            (when shown), when each was approved, and which were counted with the whole task — and their last 8 weeks.
            Never emails, notes, due dates, or questions. Mentors and teachers aren&apos;t listed.
          </p>
          <p>
            The Workshop page shows each project once a leader, the captain, a mentor, or a teacher approves it (
            <Link href="/workshop?view=review" className="text-brand-700 underline underline-offset-2 hover:text-brand-800">
              Workshop → Waiting for approval
            </Link>
            ): photos, what it does, the material, who designed it, and its design files to download.
          </p>
          {hiddenPeople > 0 && (
            <p>
              {hiddenPeople === 1 ? "1 person chose" : `${hiddenPeople} people chose`} not to be listed (in their
              Settings): they&apos;re left off the list and Recent completions. So nobody&apos;s numbers can be worked
              out from the totals, their items count in them only where at least {PUBLIC_HIDDEN_MIN_GROUP} people in the
              same subteam (or without one) are hidden
              {hiddenUncounted > 0
                ? ` — right now ${hiddenUncounted === 1 ? "1 of them isn't" : `${hiddenUncounted} of them aren't`} counted.`
                : "."}
            </p>
          )}
          <div className="flex flex-wrap gap-x-4">
            <a href={TEAM_SITE_PROGRESS_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <Globe className="size-4" aria-hidden />
              Open the progress page
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={PUBLIC_PROGRESS_PATH} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <ExternalLink className="size-4" aria-hidden />
              See the live data (JSON)
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={`${TEAM_SITE_ORIGIN}/about/team`} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <Globe className="size-4" aria-hidden />
              Our Team page
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={`${TEAM_SITE_ORIGIN}/sponsors`} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <Globe className="size-4" aria-hidden />
              Sponsors page
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={PUBLIC_SPONSORS_PATH} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <ExternalLink className="size-4" aria-hidden />
              Sponsors JSON
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={`${TEAM_SITE_ORIGIN}/events`} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <Globe className="size-4" aria-hidden />
              Events page
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={PUBLIC_EVENTS_PATH} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <ExternalLink className="size-4" aria-hidden />
              Events JSON
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={`${TEAM_SITE_ORIGIN}/workshop`} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <Globe className="size-4" aria-hidden />
              Workshop page
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={PUBLIC_WORKSHOP_PATH} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <ExternalLink className="size-4" aria-hidden />
              Workshop JSON
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={PUBLIC_TEAM_PHOTOS_PATH} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <ExternalLink className="size-4" aria-hidden />
              Team photos JSON
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
