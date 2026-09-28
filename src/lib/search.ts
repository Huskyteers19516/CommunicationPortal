// Search boxes backed by Prisma `contains` (Team members, Admin → People).

/**
 * Search text from the URL (`?q=`), trimmed and at most `max` characters, or undefined when empty.
 * Control characters are dropped: Postgres rejects a NUL byte (`?q=%00`) and would fail the whole page.
 */
export function cleanSearchText(value: string | undefined, max: number): string | undefined {
  const q = value?.replace(/\p{Cc}/gu, "").trim().slice(0, max).trim();
  return q || undefined;
}

/**
 * Prisma's `contains` doesn't escape LIKE wildcards, so `%` or `_` would match anything. Escape them (and the
 * escape character `\` itself) so a search finds exactly what was typed.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}
