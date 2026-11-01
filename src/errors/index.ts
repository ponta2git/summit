const APP_ERROR_CODES = [
  "INVARIANT_VIOLATION",
  "VALIDATION",
  "NOT_FOUND",
  "DISCORD_API",
  "DATABASE",
  "SHUTDOWN"
] as const;

type AppErrorCode = (typeof APP_ERROR_CODES)[number];

interface AppErrorOptions {
  cause?: unknown;
}

// why: 境界層のエラー分類を code で統一する。
export abstract class AppError extends Error {
  public readonly code: AppErrorCode;
  public override readonly cause: unknown;

  protected constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.cause = options.cause;
  }
}

export class InvariantViolationError extends AppError {
  public constructor(message: string, options?: AppErrorOptions) {
    super("INVARIANT_VIOLATION", message, options);
  }
}

/** A notification admission invariant is an internal defect, not a database outage. */
export class NotificationAdmissionInvariantError extends InvariantViolationError {}

export class ValidationError extends AppError {
  public constructor(message: string, options?: AppErrorOptions) {
    super("VALIDATION", message, options);
  }
}

export class NotFoundError extends AppError {
  public constructor(message: string, options?: AppErrorOptions) {
    super("NOT_FOUND", message, options);
  }
}

export class DiscordApiError extends AppError {
  public constructor(message: string, options?: AppErrorOptions) {
    super("DISCORD_API", message, options);
  }
}

export class DatabaseError extends AppError {
  public constructor(message: string, options?: AppErrorOptions) {
    super("DATABASE", message, options);
  }
}

export class ShutdownError extends AppError {
  public constructor(message: string, options?: AppErrorOptions) {
    super("SHUTDOWN", message, options);
  }
}

/** No database command started; internal callers return their operation's no-op result. */
export class NotificationNotStartedError extends Error {
  public readonly reason: "stopped" | "expired" | "queue_timeout";
  public constructor(reason: "stopped" | "expired" | "queue_timeout") {
    super("Notification database command was not started.");
    this.name = "NotificationNotStartedError";
    this.reason = reason;
  }
}
