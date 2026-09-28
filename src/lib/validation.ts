// Shared zod building blocks (client-safe). Features compose these into their own schemas.
import { z } from "zod";
import { isDateOnly } from "./dates";
import { LIMITS } from "./constants";

export const emailSchema = z
  .string({ error: "Email is required." })
  .trim()
  .toLowerCase()
  .min(1, "Email is required.")
  .max(LIMITS.emailMax, "Email is too long.")
  .pipe(z.email({ error: "Enter a valid email address." }));

export const passwordSchema = z
  .string({ error: "Password is required." })
  .min(LIMITS.passwordMin, `Password must be at least ${LIMITS.passwordMin} characters.`)
  .max(LIMITS.passwordMax, "Password is too long.");

export const nameSchema = z
  .string({ error: "Name is required." })
  .trim()
  .min(1, "Name is required.")
  .max(LIMITS.nameMax, `Name must be at most ${LIMITS.nameMax} characters.`);

export const idSchema = z.string().trim().min(1).max(64);

export const dateOnlySchema = z
  .string({ error: "Pick a date." })
  .trim()
  .refine(isDateOnly, "Pick a valid date.");

/**
 * CRLF / lone CR line breaks -> "\n". Browsers send a textarea's line breaks as CRLF, but its `maxLength` counts
 * each as one character, so text typed up to the box's limit only fits once they're one character again.
 */
export function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Required text with a max length. Line breaks are saved as "\n" (and counted as one character). */
export function text(label: string, max: number, min = 1) {
  return z
    .string({ error: `${label} is required.` })
    .overwrite(normalizeLineBreaks)
    .trim()
    .min(min, min <= 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
    .max(max, `${label} must be at most ${max} characters.`);
}

/** Optional text: "" / missing -> undefined. Line breaks are saved as "\n" (and counted as one character). */
export function optionalText(label: string, max: number) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().overwrite(normalizeLineBreaks).trim().max(max, `${label} must be at most ${max} characters.`).optional(),
  );
}

/** Form value that may arrive as a single string, an array of strings, or not at all. */
export const stringArray = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]),
  z.array(z.string().trim().min(1).max(64)),
);

/** HTML checkbox: "on" / "true" / "1" -> true, missing -> false. */
export const checkbox = z.preprocess(
  (v) => v === true || v === "on" || v === "true" || v === "1",
  z.boolean(),
);

/** Optional enum that treats "" as undefined (e.g. a <select> with an empty option). */
export function optionalEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), z.enum(values).optional());
}
