// Client-safe helpers for sign-up tasks (Task dashboard, task pages, Manage → Tasks).

/** A task's people/sign-up numbers, as the queries return them. */
export interface SignupInfo {
  /** Set up as "Let people sign up" (stays true while sign-ups are closed). */
  signupMode: boolean;
  signupOpen: boolean;
  /** Most people the task takes (everyone on it counts). Null = no limit. */
  signupLimit: number | null;
  /** People on the task right now. */
  spotsTaken: number;
}

/** Was this set up as a sign-up task (whether sign-ups are open right now or not)? */
export function isSignupTask(t: Pick<SignupInfo, "signupMode">): boolean {
  return t.signupMode;
}

export function isFull(t: Pick<SignupInfo, "signupLimit" | "spotsTaken">): boolean {
  return t.signupLimit !== null && t.spotsTaken >= t.signupLimit;
}

/** "Sign-up · 2 of 3 spots taken", "Sign-up · open", "Sign-up · full", "Sign-ups closed" — or null for assigned tasks. */
export function signupBadge(t: SignupInfo): { label: string; tone: "blue" | "gray" } | null {
  if (!isSignupTask(t)) return null;
  if (!t.signupOpen) return { label: "Sign-ups closed", tone: "gray" };
  if (t.signupLimit === null) return { label: "Sign-up · open", tone: "blue" };
  if (isFull(t)) return { label: "Sign-up · full", tone: "gray" };
  return { label: `Sign-up · ${t.spotsTaken} of ${t.signupLimit} ${t.signupLimit === 1 ? "spot" : "spots"} taken`, tone: "blue" };
}

/**
 * Spots line for task pages: "0 of 2 spots taken · 2 left", "3 people on it · no limit".
 * While sign-ups are closed nobody else can join, so it leaves out "left" / "no limit".
 */
export function spotsSummary(t: Pick<SignupInfo, "signupOpen" | "signupLimit" | "spotsTaken">): string {
  if (t.signupLimit === null) {
    const people = `${t.spotsTaken} ${t.spotsTaken === 1 ? "person" : "people"} on it`;
    return t.signupOpen ? `${people} · no limit` : people;
  }
  const taken = `${t.spotsTaken} of ${t.signupLimit} ${t.signupLimit === 1 ? "spot" : "spots"} taken`;
  if (!t.signupOpen) return taken;
  const left = Math.max(0, t.signupLimit - t.spotsTaken);
  return `${taken} · ${left === 0 ? "full" : `${left} left`}`;
}
