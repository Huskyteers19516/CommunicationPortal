// Typed errors thrown by services. Server actions turn these into friendly form errors.

export class AppError extends Error {
  /** Safe to show to the user. */
  readonly userMessage: string;
  /** Optional reason the page can react to (passed on as ActionState.code), e.g. TASK_FINISHED_CODES. */
  readonly code?: string;
  constructor(userMessage: string, code?: string) {
    super(userMessage);
    this.name = new.target.name;
    this.userMessage = userMessage;
    if (code) this.code = code;
  }
}

/** Input failed validation. `fieldErrors` maps form field names to messages. */
export class ValidationError extends AppError {
  readonly fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.fieldErrors = fieldErrors;
  }
}

/** Not logged in / not active. */
export class UnauthorizedError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super(message);
  }
}

/** Logged in but not allowed to do this. */
export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that.") {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "That item no longer exists.") {
    super(message);
  }
}

/** The action conflicts with the current state (e.g. reviewing an already-approved task). */
export class ConflictError extends AppError {
  constructor(message: string, code?: string) {
    super(message, code);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many attempts. Please wait a few minutes and try again.") {
    super(message);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
