// Links people type in (client-safe): the same check runs in the browser (previews) and on the server.
import { LIMITS } from "./constants";

/** An absolute http(s) URL, normalised. Anything else (javascript:, data:, relative…) is rejected. */
export function parseHttpUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > LIMITS.resourceUrlMax) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    // Percent-encoding can lengthen it; the stored value must still fit so it can be saved again.
    return url.href.length <= LIMITS.resourceUrlMax ? url.href : null;
  } catch {
    return null;
  }
}
