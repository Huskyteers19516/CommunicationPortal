import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { isAppError, ValidationError } from "./errors";

let nonce = 0;
const nextNonce = () => ++nonce + Date.now();

/** String values of a form, minus Next internals and anything password-like. */
function echoValues(formData?: FormData): Record<string, string> | undefined {
  if (!formData) return undefined;
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION") || /password|token|code/i.test(key) || typeof value !== "string") continue;
    values[key] = value;
  }
  return values;
}

/**
 * Run a mutation for a form Server Action and convert errors into an ActionState.
 * - `redirect()` / `notFound()` inside `fn` still work (they are re-thrown).
 * - Return a string from `fn` to use it as the success message.
 * - Pass `formData` to echo the submitted values back on failure (see ActionState.values).
 *
 *   export async function createThing(_prev: ActionState, formData: FormData): Promise<ActionState> {
 *     return runAction(async () => {
 *       const ctx = await getServiceContext();
 *       await createThingService(ctx, formDataToObject(formData));
 *       revalidatePath("/", "layout");
 *     }, { success: "Saved.", formData });
 *   }
 */
export async function runAction(
  fn: () => Promise<void | string>,
  options: { success?: string; formData?: FormData } = {},
): Promise<ActionState> {
  try {
    const msg = await fn();
    return { ok: true, message: typeof msg === "string" ? msg : options.success, nonce: nextNonce() };
  } catch (e) {
    unstable_rethrow(e);
    const values = echoValues(options.formData);
    if (e instanceof ValidationError) {
      return { ok: false, message: e.userMessage, fieldErrors: e.fieldErrors, values, nonce: nextNonce() };
    }
    if (isAppError(e)) return { ok: false, message: e.userMessage, values, nonce: nextNonce(), ...(e.code ? { code: e.code } : {}) };
    console.error("[action] unexpected error", e);
    return { ok: false, message: "Something went wrong. Please try again.", values, nonce: nextNonce() };
  }
}

/** Parse FormData (or a plain object) with a zod schema; throws ValidationError with per-field messages. */
export function parseInput<S extends z.ZodType>(schema: S, input: FormData | Record<string, unknown>): z.infer<S> {
  const raw = input instanceof FormData ? formDataToObject(input) : input;
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_form";
    fieldErrors[key] ??= issue.message;
  }
  const first = Object.values(fieldErrors)[0];
  throw new ValidationError(Object.keys(fieldErrors).length === 1 && first ? first : "Please fix the highlighted fields.", fieldErrors);
}

/**
 * FormData -> object. Repeated keys (e.g. checkboxes named "userIds") become arrays, appended in place:
 * linear time, so a big request of repeated keys can't tie up the server (actions run before any sign-in check).
 */
export function formDataToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of fd.entries()) {
    if (key.startsWith("$ACTION")) continue;
    const v = typeof value === "string" ? value : value.name;
    // Own keys only: a field named "constructor" is a plain field, not Object's. (One named "__proto__" is dropped.)
    if (Object.hasOwn(out, key)) {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(v);
      else out[key] = [prev, v];
    } else {
      out[key] = v;
    }
  }
  return out;
}
