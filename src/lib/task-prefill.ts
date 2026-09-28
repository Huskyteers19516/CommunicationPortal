// ?people=<id>,<id>…, ?due= and ?back= on /manage/tasks/new (Attendance's "Assign a task to the people coming"):
// client-safe.
import { type DateOnly, isDateOnly } from "./dates";

/** Most ids read from the address (a team is ~40 people). */
export const PEOPLE_PARAM_MAX = 200;

/** "a,b" / ["a", "b,c"] → unique ids in order (at most PEOPLE_PARAM_MAX; anything odd is dropped). */
export function parsePeopleParam(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= PEOPLE_PARAM_MAX) break;
  }
  return ids;
}

/**
 * The requested people the task form may start with: only those in the actor's own picker (people they can
 * assign), and not ones shown just as a note (e.g. "Not active"). Everyone else is quietly left out.
 */
export function prefillAssigneeIds(requested: string[], groups: { people: { id: string; note?: string }[] }[]): string[] {
  const allowed = new Set(groups.flatMap((g) => g.people.filter((p) => !p.note).map((p) => p.id)));
  return requested.filter((id) => allowed.has(id));
}

/** ?due=YYYY-MM-DD (the planned day): used as the due date when it's a real day within [min, max], else null. */
export function prefillDueDate(value: string | string[] | undefined, min: DateOnly, max: DateOnly): DateOnly | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && isDateOnly(raw) && raw >= min && raw <= max ? raw : null;
}

/** ?back=… : where "back" goes. Only Attendance's "Who's coming" for a day (never another site or page). */
export function prefillBackHref(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^\/attendance\/plan\?day=\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}
