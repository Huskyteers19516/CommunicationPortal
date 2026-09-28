// Browser-only: an unsaved new entry's title and text, kept per page in this browser (localStorage), so a phone
// that reloads the tab, a stray Escape, or leaving the page doesn't lose what someone typed. A convenience only:
// when the browser refuses storage (private windows), the editor still asks before throwing text away.
import type { NotebookVersionText } from "@/lib/notebook";

const PREFIX = "hk-notebook-draft:";
const EVENT = "hk-notebook-draft-change";

function key(pageId: string) {
  return `${PREFIX}${pageId}`;
}

/** The stored draft as a string ("" when there's none), for useSyncExternalStore. */
export function draftSnapshot(pageId: string): string {
  try {
    return window.localStorage.getItem(key(pageId)) ?? "";
  } catch {
    return "";
  }
}

/** The draft for this page, or null. */
export function readDraft(pageId: string): NotebookVersionText | null {
  const raw = draftSnapshot(pageId);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { title, body } = value as Record<string, unknown>;
    if (typeof title !== "string" || typeof body !== "string" || (!title.trim() && !body.trim())) return null;
    return { title, body };
  } catch {
    return null;
  }
}

/** Keep (or, when it's empty, forget) this page's draft. */
export function writeDraft(pageId: string, draft: NotebookVersionText) {
  try {
    if (!draft.title.trim() && !draft.body.trim()) window.localStorage.removeItem(key(pageId));
    else window.localStorage.setItem(key(pageId), JSON.stringify({ title: draft.title, body: draft.body }));
  } catch {
    // Storage refused or full: the editor still asks before discarding.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function clearDraft(pageId: string) {
  writeDraft(pageId, { title: "", body: "" });
}

export function subscribeDrafts(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}
