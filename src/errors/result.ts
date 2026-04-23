import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { DatabaseError, DiscordApiError, type AppError, type AppResult } from "./index.js";

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

/**
 * Wraps a Promise that may throw a Discord API error into a DiscordApiError-typed ResultAsync.
 *
 * @remarks
 * 境界層で Discord 呼び出しを Result に揃えるためのヘルパ。ADR-0015 の AppError 分類に
 * 従い Discord 失敗は `DiscordApiError` として伝播させる。DB 失敗と同格扱い。
 * @see ADR-0015
 */
export const fromDiscordPromise = <T>(promise: Promise<T>, message: string): ResultAsync<T, DiscordApiError> =>
  ResultAsync.fromPromise(promise, (cause) => new DiscordApiError(message, { cause }));
