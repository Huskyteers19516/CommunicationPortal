// The team website's public pages: their settings (Admin → Approvals → Team website), kept in the TeamNote
// "public-progress" as JSON — the progress page (on/off, names, task titles, where counting starts) and the
// Sponsors and Events pages (on/off each). Everyone with admin access changes them; each person's own "Show me on the team
// website" switch is in services/settings.ts.
import { z } from "zod";
import { addDays, todayInTimezone } from "@/lib/dates";
import {
  NAME_STYLES,
  PUBLIC_PROGRESS_KEY,
  type PublicProgressSettings,
  serializePublicProgressSettings,
} from "@/lib/public-progress";
import { checkbox, dateOnlySchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ForbiddenError, ValidationError } from "../errors";
import { canManagePublicProgress } from "../permissions";
import { publicProgressIdSalt } from "../queries/public-progress";
import { enforceRateLimit } from "../rate-limit";

/** Saves per person per hour. */
export const PUBLIC_PROGRESS_SETTINGS_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 } as const;

export const PUBLIC_PROGRESS_FORBIDDEN = "Only people with admin access can change what the team website shows.";
export const PUBLIC_PROGRESS_SINCE_RANGE = "Pick a day within the last 5 years (and no more than a year ahead).";

const settingsInput = z.object({
  enabled: checkbox,
  nameStyle: z.enum(NAME_STYLES, { error: "Pick how names are shown." }),
  showTaskTitles: checkbox,
  since: z.preprocess((v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? undefined : v), dateOnlySchema.optional()),
  showSponsors: checkbox,
  showEvents: checkbox,
});

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/**
 * Save the team website's settings. Unchecked boxes arrive missing (= off); an empty "Count tasks due from" goes back to the
 * attendance reports' start. Also makes the people ids' salt if there isn't one yet, so the public request (anonymous)
 * normally only reads.
 */
export async function updatePublicProgressSettings(ctx: ServiceContext, raw: unknown): Promise<PublicProgressSettings> {
  if (ctx.actor.status !== "ACTIVE" || !canManagePublicProgress(ctx.actor)) throw new ForbiddenError(PUBLIC_PROGRESS_FORBIDDEN);
  const input = parseInput(settingsInput, asRecord(raw));
  const today = todayInTimezone(ctx.config.teamTimezone, ctx.now);
  if (input.since && (input.since < addDays(today, -5 * 366) || input.since > addDays(today, 366))) {
    throw new ValidationError(PUBLIC_PROGRESS_SINCE_RANGE, { since: PUBLIC_PROGRESS_SINCE_RANGE });
  }
  const { limit, windowMs } = PUBLIC_PROGRESS_SETTINGS_RATE_LIMIT;
  await enforceRateLimit(ctx.db, `public-progress:${ctx.actor.id}`, limit, windowMs, ctx.now);

  const settings: PublicProgressSettings = {
    enabled: input.enabled,
    nameStyle: input.nameStyle,
    showTaskTitles: input.showTaskTitles,
    since: input.since ?? null,
    showSponsors: input.showSponsors,
    showEvents: input.showEvents,
  };
  const body = serializePublicProgressSettings(settings);
  await ctx.db.teamNote.upsert({
    where: { key: PUBLIC_PROGRESS_KEY },
    create: { key: PUBLIC_PROGRESS_KEY, body, updatedById: ctx.actor.id },
    update: { body, updatedById: ctx.actor.id },
  });
  await publicProgressIdSalt(ctx.db);
  return settings;
}
