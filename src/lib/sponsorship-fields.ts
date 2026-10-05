// A sponsorship's fields, validated (client-safe): the server's check for the add/edit forms and the
// import, which the import preview runs too, so the preview and the server always agree on what's OK.
import { z } from "zod";
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { LIMITS, SPONSORSHIP_STAGES } from "./constants";
import { parseDollars } from "./money";
import { withHttps } from "./sponsorships";
import { parseHttpUrl } from "./urls";
import { checkbox, dateOnlySchema, emailSchema, idSchema, optionalText, text } from "./validation";

export const WEBSITE_MESSAGE = "Enter the website's full address, like https://example.com";

const blankToUndefined = (v: unknown) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v);

/** A website as people type it ("polymaker.com/edu") → a normalised http(s) URL, or null. */
export function normalizeWebsite(value: string): string | null {
  return value.trim() ? parseHttpUrl(withHttps(value)) : null;
}

/** The server's email check ("josé@…" or "jane..doe@…" fail it even though they look like addresses). */
export function isValidEmail(value: string): boolean {
  return emailSchema.safeParse(value).success;
}

const websiteField = z.preprocess(
  (v) => (typeof v === "string" ? v : ""),
  z.string().transform((v, ctx) => {
    if (!v.trim()) return "";
    const url = normalizeWebsite(v);
    if (!url) {
      ctx.addIssue({ code: "custom", message: WEBSITE_MESSAGE });
      return z.NEVER;
    }
    return url;
  }),
);

const emailField = z.preprocess(
  (v) => blankToUndefined(typeof v === "string" ? v.replace(/^\s*mailto:/i, "") : v),
  emailSchema.optional(),
);

/** "$1,000" / "1000" / "1,000.00" (form) or a number (import) → whole dollars, or null. */
const amountField = z
  .preprocess(
    (v) => (v === undefined || v === null ? "" : v),
    z.union([z.string(), z.number()], { error: "Enter the amount in dollars, like 1,000." }),
  )
  .transform((v, ctx): number | null => {
    if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 0 && v <= LIMITS.sponsorAmountMax) return v;
      ctx.addIssue({ code: "custom", message: "Enter the amount in whole dollars." });
      return z.NEVER;
    }
    const result = parseDollars(v);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message });
      return z.NEVER;
    }
    return result.value;
  });

export const stageField = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? "NOT_STARTED" : v),
  z.enum(SPONSORSHIP_STAGES as [SponsorshipStage, ...SponsorshipStage[]], { error: "Pick a stage." }),
);

const optionalDate = z.preprocess(blankToUndefined, dateOnlySchema.optional());

export const sponsorshipFields = z.object({
  name: text("Sponsor name", LIMITS.sponsorNameMax),
  website: websiteField,
  contactName: optionalText("Contact name", LIMITS.nameMax),
  contactEmail: emailField,
  asking: optionalText("What we're asking for", LIMITS.sponsorAskingMax),
  amountReceived: amountField,
  stage: stageField,
  ownerId: z.preprocess(blankToUndefined, idSchema.optional()),
  submittedOn: optionalDate,
  acceptedOn: optionalDate,
  closesOn: optionalDate,
  notes: optionalText("Notes", LIMITS.sponsorNotesMax),
});

/**
 * The edit form's "Team website" section (not in the import): "Thank them on the team website" (a checkbox: missing =
 * off) and "Name on the website" (empty = the sponsor's name). The form sends `websiteFields` with them, so a save
 * without that section (the import, older forms) never changes them.
 */
export const sponsorshipWebsiteFields = z.object({
  showOnWebsite: checkbox,
  publicName: optionalText("Name on the website", LIMITS.sponsorNameMax),
});

export type SponsorshipFields = z.infer<typeof sponsorshipFields>;
export type SponsorshipFieldName = keyof SponsorshipFields;
