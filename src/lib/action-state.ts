// Shape returned by every form Server Action (consumed with useActionState). Client-safe.
export type ActionState = {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string>;
  /**
   * On failure: the submitted text values (passwords excluded), so the form can re-render them.
   * React resets uncontrolled forms after an action — use `defaultValue={state?.values?.title ?? initial}`.
   */
  values?: Record<string, string>;
  /** Bumps on every submission so clients can react (e.g. reset a form or close a panel). */
  nonce?: number;
  /**
   * On failure, sometimes: why, for pages that show it differently from an error (AppError.code), e.g.
   * TASK_FINISHED_CODES below.
   */
  code?: string;
} | null;

export const initialActionState: ActionState = null;

/**
 * ActionState.code when a member's check-off (uncheck, note) was refused because a leader marked the item's task
 * finished meanwhile (services/checklist.ts): it was counted as done for them, or closed without credit. The
 * checklist shows that as news rather than an error.
 */
export const TASK_FINISHED_CODES = { counted: "taskFinishedCounted", closed: "taskFinishedClosed" } as const;
