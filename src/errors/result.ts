import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { DatabaseError, type AppError, type AppResult } from "./index.js";

/**
 * Lifts a synchronous AppResult into a ResultAsync without introducing a new async step.
 */
export const toResultAsync = <T, E extends AppError>(result: AppResult<T, E>): ResultAsync<T, E> =>
  result.match(
    (value) => okAsync(value),
    (error) => errAsync(error),
  );

/**
 * Wraps a Promise that may throw a DB-layer error into a DatabaseError-typed ResultAsync.
 */
export const fromDatabasePromise = <T>(promise: Promise<T>, message: string): ResultAsync<T, DatabaseError> =>
  ResultAsync.fromPromise(promise, (cause) => new DatabaseError(message, { cause }));
