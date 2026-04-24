import { err, ok, type Result } from "neverthrow";

export const APP_ERROR_CODES = [
  "INVARIANT_VIOLATION",
  "VALIDATION",
  "NOT_FOUND",
  "DISCORD_API",
  "DATABASE",
  "RACE_LOST"
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface AppErrorOptions {
  cause?: unknown;
}

// why: 境界層のエラー分類統一 → ADR-0015
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

export class RaceLostError extends AppError {
  public constructor(message: string, options?: AppErrorOptions) {
    super("RACE_LOST", message, options);
  }
}

export type AppResult<T, E extends AppError = AppError> = Result<T, E>;

export const okResult = <T>(value: T): AppResult<T, never> => ok(value);
export const errResult = <E extends AppError>(error: E): AppResult<never, E> => err(error);

export const toAppError = (error: unknown, fallbackMessage: string): AppError => {
  if (error instanceof AppError) {
    return error;
  }

  return new InvariantViolationError(fallbackMessage, { cause: error });
};
