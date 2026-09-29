import "server-only";
import type { Actor } from "./actor";
import { getCurrentUser } from "./auth/session";
import { type Db, prisma } from "./db";
import { env } from "./env";
import { UnauthorizedError } from "./errors";
import { getObjectStore, type ObjectStore } from "./files/object-store";
import { appNotifier } from "./notifications";
import type { Notifier } from "./notifications/events";

export interface PublicContext {
  db: Db;
  notifier: Notifier;
  now: Date;
  config: { appUrl: string; teamTimezone: string; adminEmails: string[]; teamJoinCode: string | null };
  /**
   * Cloudflare R2 for uploaded files, when the R2_* settings are set (src/server/files/object-store.ts). Missing or
   * null: files are stored in Postgres (tests leave it out unless they test R2).
   */
  objectStore?: ObjectStore | null;
}

/** Everything a service needs. Tests build these by hand (see tests/helpers). */
export interface ServiceContext extends PublicContext {
  actor: Actor;
}

export function getPublicContext(): PublicContext {
  return {
    db: prisma,
    notifier: appNotifier,
    now: new Date(),
    config: {
      appUrl: env.appUrl,
      teamTimezone: env.teamTimezone,
      adminEmails: env.adminEmails,
      teamJoinCode: env.teamJoinCode,
    },
    objectStore: getObjectStore(),
  };
}

/** For Server Actions: context for the signed-in ACTIVE user. Throws UnauthorizedError otherwise. */
export async function getServiceContext(): Promise<ServiceContext> {
  const actor = await getCurrentUser();
  if (!actor || actor.status !== "ACTIVE") throw new UnauthorizedError();
  return { ...getPublicContext(), actor };
}
