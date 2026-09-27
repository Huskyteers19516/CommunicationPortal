// Copy shared by admin Server Actions and their client forms.

import type { ActionState } from "@/lib/action-state";

export const TEST_EMAIL_MESSAGES = {
  SENT: "Sent! Check your inbox (and the spam folder, just in case).",
  FAILED: "Failed — check the log below for the error.",
  SKIPPED: "Email isn't configured yet — messages are only logged.",
} as const;

export const DISCORD_TEST_MESSAGES = {
  SENT: "Sent! Check the Discord channel.",
  FAILED: "Discord didn't accept it — check the log below for the error (is the webhook deleted?).",
  SKIPPED: "Discord isn't set up yet — add DISCORD_WEBHOOK_URL in Vercel, then redeploy.",
} as const;

export const APPROVED_MESSAGE = "Approved. They can sign in now and will get an email.";
export const REJECTED_MESSAGE = "Sign-up rejected.";

/** What the admin "Password reset" action returns: the usual ActionState plus the one-time link (on success). */
export type ResetLinkState =
  | (NonNullable<ActionState> & {
      /** Shown once to the admin so they can pass it on privately. */
      resetUrl?: string;
      /** Whether email is set up, i.e. whether the link was also emailed. */
      emailed?: boolean;
    })
  | null;

export const RESET_LINK_HINT = "Works once, for 1 hour. Send it to them privately.";
export const RESET_LINK_NOT_EMAILED = "Email isn't set up, so it was not emailed.";
/** Non-owners only get reset links by email; without email set up, an owner has to make one. */
export const RESET_LINK_OWNER_ONLY = "Email isn't set up, so the reset link couldn't be sent. Ask an owner to create one for them.";
