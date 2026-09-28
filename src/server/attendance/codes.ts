// Rotating attendance codes (pure; the session secret never leaves the server).
//
// Time is cut into 30-second slots. For each slot an open session shows:
// - a QR code linking to /attendance/scan/<token>, token = "<sessionId>.<slot base36>.<signature>",
//   signature = HMAC-SHA256(secret, "qr:<sessionId>:<slot>") (first 16 bytes, base64url = 22 characters).
//   A scanned link keeps working for about 5 minutes, so signing in on the way still lands the check-in.
// - a 6-digit code for people who can't scan, HMAC-derived for the same slot and accepted for about 2 minutes.
//   Typed codes are matched against today's open sessions only, and attempts are rate-limited by the service.
// Signatures and codes are compared in constant time.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CODE_SLOT_MS = 30_000;
/** How many slots old a scanned QR link may be (10 × 30 s ≈ 5 minutes, e.g. a sign-in in between). */
export const QR_MAX_AGE_SLOTS = 10;
/** How many slots old a typed code may be (3 × 30 s, plus the current slot ≈ 1.5–2 minutes). */
export const TYPED_CODE_MAX_AGE_SLOTS = 3;
/** Another server instance's clock may be a little ahead of the one that made the code. */
export const FUTURE_SLOTS = 1;
export const TYPED_CODE_LENGTH = 6;

const SIGNATURE_BYTES = 16;
const SIGNATURE_LENGTH = 22; // base64url of 16 bytes
const TOKEN_RE = /^([a-z0-9]{1,64})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})$/i;

/** A fresh random secret for a session (256 bits). */
export function newSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function slotAt(now: Date): number {
  return Math.floor(now.getTime() / CODE_SLOT_MS);
}

/** When the slot ends (the next code starts). */
export function slotEndsAt(slot: number): Date {
  return new Date((slot + 1) * CODE_SLOT_MS);
}

function hmac(secret: string, message: string): Buffer {
  return createHmac("sha256", secret).update(message).digest();
}

/** Equal strings, compared without leaking where they differ. Different lengths are simply unequal. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left); // same work either way
    return false;
  }
  return timingSafeEqual(left, right);
}

export function qrSignature(secret: string, sessionId: string, slot: number): string {
  return hmac(secret, `qr:${sessionId}:${slot}`).subarray(0, SIGNATURE_BYTES).toString("base64url");
}

/** The QR token for a session and slot. */
export function qrTokenFor(secret: string, sessionId: string, slot: number): string {
  return `${sessionId}.${slot.toString(36)}.${qrSignature(secret, sessionId, slot)}`;
}

export interface ParsedQrToken {
  sessionId: string;
  slot: number;
  signature: string;
}

/** Split a token into its parts, or null if it isn't shaped like one of ours. */
export function parseQrToken(token: string): ParsedQrToken | null {
  const m = TOKEN_RE.exec(token.trim());
  if (!m) return null;
  const slot = Number.parseInt(m[2], 36);
  if (!Number.isSafeInteger(slot) || slot < 0) return null;
  const signature = m[3];
  if (signature.length !== SIGNATURE_LENGTH) return null;
  return { sessionId: m[1], slot, signature };
}

export type QrVerdict = "ok" | "expired" | "invalid";

/**
 * Check a parsed token against the session's secret. The signature is checked first (a forged token is
 * "invalid", never "expired"); a genuine one is "expired" once it's more than QR_MAX_AGE_SLOTS old.
 */
export function verifyQrToken(parsed: ParsedQrToken, secret: string, now: Date): QrVerdict {
  if (!safeEqual(parsed.signature, qrSignature(secret, parsed.sessionId, parsed.slot))) return "invalid";
  const current = slotAt(now);
  if (parsed.slot > current + FUTURE_SLOTS) return "invalid";
  if (parsed.slot < current - QR_MAX_AGE_SLOTS) return "expired";
  return "ok";
}

/** The 6-digit code for a session and slot, e.g. "042917". */
export function typedCodeFor(secret: string, sessionId: string, slot: number): string {
  const n = hmac(secret, `code:${sessionId}:${slot}`).readUInt32BE(0) % 10 ** TYPED_CODE_LENGTH;
  return n.toString().padStart(TYPED_CODE_LENGTH, "0");
}

/** "123 456", "123-456" → "123456"; anything that isn't 6 digits after that → null. */
export function normalizeTypedCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${TYPED_CODE_LENGTH}}$`).test(digits) ? digits : null;
}

/**
 * Which of these sessions (today's open ones) the typed code belongs to, or null. Every session and slot in
 * the window is compared (no early exit), so timing doesn't say which part matched.
 */
export function matchTypedCode(code: string, sessions: { id: string; secret: string }[], now: Date): string | null {
  const current = slotAt(now);
  let match: string | null = null;
  for (const session of sessions) {
    for (let slot = current - TYPED_CODE_MAX_AGE_SLOTS; slot <= current + FUTURE_SLOTS; slot++) {
      const equal = safeEqual(code, typedCodeFor(session.secret, session.id, slot));
      if (equal && match === null) match = session.id;
    }
  }
  return match;
}

/** Everything the projector screen needs for the current slot (the secret itself stays here). */
export function currentCodes(secret: string, sessionId: string, now: Date): { token: string; code: string; expiresAt: Date } {
  const slot = slotAt(now);
  return { token: qrTokenFor(secret, sessionId, slot), code: typedCodeFor(secret, sessionId, slot), expiresAt: slotEndsAt(slot) };
}
