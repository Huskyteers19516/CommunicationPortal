import "server-only";
import type { Actor } from "@/server/actor";
import { requireActiveUser } from "@/server/auth/session";
import { canUseSponsorships } from "@/server/permissions";

/**
 * For Sponsorships pages: the signed-in ACTIVE user when they can use Sponsorships (the Business team and
 * staff), else null — the page then shows <NoSponsorshipAccess /> (a short explanation, no data).
 */
export async function getSponsorshipUser(): Promise<Actor | null> {
  const actor = await requireActiveUser();
  return canUseSponsorships(actor) ? actor : null;
}
