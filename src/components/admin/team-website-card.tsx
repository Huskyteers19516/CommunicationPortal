"use client";

import { ExternalLink, Globe } from "lucide-react";
import { useActionState } from "react";
import { updatePublicProgressSettingsAction } from "@/app/(app)/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, Field, Select, Input } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { addDays, type DateOnly, formatDateOnly } from "@/lib/dates";
import {
  NAME_STYLE_LABELS,
  NAME_STYLES,
  PUBLIC_PROGRESS_PATH,
  type PublicProgressSettings,
  TEAM_SITE_PROGRESS_URL,
} from "@/lib/public-progress";

const linkClass =
  "inline-flex min-h-10 items-center gap-1.5 rounded-md text-sm font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/**
 * Admin → Approvals → Team website: the public progress page on huskyteers19516.github.io (on/off, how names are
 * shown, task titles, where counting starts), with links to the page and the live JSON. Everyone with admin access.
 */
export function TeamWebsiteCard({
  settings,
  defaultSince,
  hiddenPeople,
  today,
}: {
  settings: PublicProgressSettings;
  /** The attendance reports' start: used while "Count tasks due from" is empty. */
  defaultSince: DateOnly;
  /** People who turned off "Show me on the team website" (a count only). */
  hiddenPeople: number;
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

  return (
    <Card role="region" aria-label="Team website">
      <CardHeader
        title="Team website"
        description="Live progress for guests on the team's site — no sign-in."
        actions={<Badge tone={settings.enabled ? "green" : "gray"}>{settings.enabled ? "On" : "Off"}</Badge>}
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
          <Field label="Names" htmlFor="public-progress-names" error={fieldErrors.nameStyle}>
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
            label="Show task titles in “Recently done”"
            description="Off: it only says which subteam finished something."
          />
          <Field
            label="Count tasks due from"
            htmlFor="public-progress-since"
            optional
            error={fieldErrors.since}
            hint={`Empty: from when attendance reports start (${formatDateOnly(defaultSince, today)}).`}
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
          <SubmitButton pendingText="Saving…" className="w-full sm:w-auto">
            Save
          </SubmitButton>
          <FormMessage state={state} />
        </form>

        <div className="space-y-2 border-t border-ink-100 pt-4 text-sm text-ink-600">
          <p>
            Guests see each person&apos;s name and position, how many checklist items they&apos;ve finished and have open,
            and the subteams&apos; and team&apos;s totals. Never emails, notes, due dates, or questions. Mentors and
            teachers aren&apos;t listed.
          </p>
          {hiddenPeople > 0 && (
            <p>
              {hiddenPeople === 1 ? "1 person chose" : `${hiddenPeople} people chose`} not to be listed (in their
              Settings). Their items still count in the totals.
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
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
