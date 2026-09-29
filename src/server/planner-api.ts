import "server-only";
// The planner's JSON API (src/app/api/planner/**): the Pedro Pathing planner served by this site (/planner/) calls
// it with fetch(…, { credentials: "same-origin" }) to open and save paths in the team library. Helpers shared by
// the route handlers:
// - Always JSON, never cached (`Cache-Control: no-store`) or sniffed (`nosniff`). Errors are {"error", "fieldErrors"?}.
// - Signed in and ACTIVE only: everyone else gets a JSON 401 (never the HTML sign-in redirect).
// - Cross-site request forgery: every change (POST/PUT/DELETE) must send `Content-Type: application/json` and
//   `X-Planner: 1` (a page on another site can't send either without the browser asking us first, and we never
//   allow it: no CORS headers), and when the browser says where it comes from (`Origin`, `Sec-Fetch-Site`) it must
//   be this site.
// - Bodies are read up to PLANNER_API_BODY_MAX_BYTES, before any parsing.
// - Every request a person makes counts toward PLANNER_API_REQUEST_LIMIT (429 past it), checked once they're known
//   and before a body is read or checked — so refused requests count too, not only saves (those have their own
//   limits in services/planner-paths.ts).
import { type NextRequest, NextResponse } from "next/server";
import type { Actor } from "./actor";
import { getCurrentUser } from "./auth/session";
import { getPublicContext, type ServiceContext } from "./context";
import { prisma } from "./db";
import { env } from "./env";
import {
  ConflictError,
  ForbiddenError,
  isAppError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "./errors";
import { consumeRateLimit } from "./rate-limit";
import { PLANNER_PATH_TOO_BIG, PlannerPathConflictError, PlannerPathTooBigError } from "./services/planner-paths";

/** The biggest request body read (a 256 KB .pp as JSON text, plus the name and notes). */
export const PLANNER_API_BODY_MAX_BYTES = 300 * 1024;

export const PLANNER_API_SIGNED_OUT = "Sign in to the Huskyteers Portal to use the team's saved paths.";
export const PLANNER_API_INACTIVE = "Your account isn't active yet, so you can't use the team's saved paths.";
export const PLANNER_API_CROSS_SITE = "This request didn't come from the planner on this site.";
export const PLANNER_API_BAD_JSON = "The request wasn't valid JSON.";
export const PLANNER_API_RATE_LIMITED = "Too many requests to the team's saved paths. Wait a few minutes and try again.";

/**
 * Planner API requests per person per hour, every method (opening the planner, listing, searching, opening, saving,
 * removing — and requests that are refused). Far above what drawing and saving paths needs.
 */
export const PLANNER_API_REQUEST_LIMIT = { limit: 1200, windowMs: 60 * 60 * 1000 } as const;

/** The RateLimit counter's key for a person's planner API requests. */
export function plannerApiRateKey(userId: string): string {
  return `planner-api:${userId}`;
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

/** A JSON answer with the API's headers. */
export function plannerJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

/** An empty answer (204 after a removal) with the API's headers. */
export function plannerNoContent(): Response {
  return new Response(null, { status: 204, headers: HEADERS });
}

/** {"error": message} (+ "fieldErrors" when there are any). */
export function plannerError(status: number, message: string, fieldErrors?: Record<string, string>): NextResponse {
  return plannerJson(fieldErrors && Object.keys(fieldErrors).length > 0 ? { error: message, fieldErrors } : { error: message }, status);
}

/**
 * The signed-in ACTIVE person, or the answer to send back: 401 (signed out, not active), 429 (over
 * PLANNER_API_REQUEST_LIMIT; this request counts toward it).
 */
export async function plannerActor(): Promise<Actor | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return plannerError(401, PLANNER_API_SIGNED_OUT);
  if (user.status !== "ACTIVE") return plannerError(401, PLANNER_API_INACTIVE);
  const { limit, windowMs } = PLANNER_API_REQUEST_LIMIT;
  if (!(await consumeRateLimit(prisma, plannerApiRateKey(user.id), limit, windowMs))) {
    return plannerError(429, PLANNER_API_RATE_LIMITED);
  }
  return user;
}

/** A service context for the person (the same one Server Actions build). */
export function plannerContext(actor: Actor): ServiceContext {
  return { ...getPublicContext(), actor };
}

function firstValue(header: string | null): string | null {
  const v = header?.split(",")[0]?.trim();
  return v ? v : null;
}

/** This site's own origins: the configured address, and the one this request came to. */
function ownOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>([request.nextUrl.origin]);
  try {
    origins.add(new URL(env.appUrl).origin);
  } catch {
    // An APP_URL that isn't a URL: the request's own origin still works.
  }
  const host = firstValue(request.headers.get("x-forwarded-host")) ?? firstValue(request.headers.get("host"));
  const proto = firstValue(request.headers.get("x-forwarded-proto")) ?? request.nextUrl.protocol.replace(/:$/, "");
  if (host && /^https?$/.test(proto)) origins.add(`${proto}://${host}`.toLowerCase());
  return origins;
}

/**
 * Why a change (POST/PUT/DELETE) isn't from the planner on this site, or null when it is: it must be JSON, carry
 * `X-Planner: 1`, and come from this site when the browser says (`Sec-Fetch-Site`, `Origin`).
 */
export function plannerCsrfProblem(request: NextRequest): string | null {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) return "Send the request as JSON (Content-Type: application/json).";
  if (request.headers.get("x-planner") !== "1") return PLANNER_API_CROSS_SITE;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return PLANNER_API_CROSS_SITE;
  const origin = request.headers.get("origin");
  if (origin !== null && !ownOrigins(request).has(origin.toLowerCase())) return PLANNER_API_CROSS_SITE;
  return null;
}

/** The 403 for a change that isn't from the planner on this site, or null. */
export function plannerCsrfResponse(request: NextRequest): NextResponse | null {
  const problem = plannerCsrfProblem(request);
  return problem ? plannerError(403, problem) : null;
}

/**
 * The request's JSON object, read up to PLANNER_API_BODY_MAX_BYTES (413 past that, without reading the rest), or
 * the error to send back (400: not JSON, or not an object).
 */
export async function readPlannerJson(request: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PLANNER_API_BODY_MAX_BYTES) return plannerError(413, PLANNER_PATH_TOO_BIG);
  let text: string;
  try {
    const bytes = await readCapped(request, PLANNER_API_BODY_MAX_BYTES);
    if (bytes === null) return plannerError(413, PLANNER_PATH_TOO_BIG);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return plannerError(400, PLANNER_API_BAD_JSON);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return plannerError(400, PLANNER_API_BAD_JSON);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return plannerError(400, "Send a JSON object.");
  return parsed as Record<string, unknown>;
}

/** The body's bytes, or null once it's longer than `max` (it stops reading there). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A service's error as the API's answer (unexpected ones are logged and answered 500 without details). */
export function plannerErrorResponse(e: unknown): NextResponse {
  if (e instanceof PlannerPathTooBigError) return plannerError(413, e.userMessage, e.fieldErrors);
  if (e instanceof ValidationError) return plannerError(400, e.userMessage, e.fieldErrors);
  if (e instanceof PlannerPathConflictError) return plannerJson({ error: e.userMessage, current: e.current }, 409);
  if (e instanceof ConflictError) return plannerError(409, e.userMessage);
  if (e instanceof UnauthorizedError) return plannerError(401, e.userMessage);
  if (e instanceof ForbiddenError) return plannerError(403, e.userMessage);
  if (e instanceof NotFoundError) return plannerError(404, e.userMessage);
  if (e instanceof RateLimitError) return plannerError(429, e.userMessage);
  if (isAppError(e)) return plannerError(400, e.userMessage);
  console.error("[planner api] unexpected error", e);
  return plannerError(500, "Something went wrong. Please try again.");
}
