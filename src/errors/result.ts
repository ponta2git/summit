import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { DatabaseError, DiscordApiError, type AppError, type AppResult } from "./index.js";

export const toResultAsync = <T, E extends AppError>(result: AppResult<T, E>): ResultAsync<T, E> =>
  result.match(
    (value) => okAsync(value),
    (error) => errAsync(error),
  );

export const fromDatabasePromise = <T>(promise: Promise<T>, message: string): ResultAsync<T, DatabaseError> =>
  ResultAsync.fromPromise(promise, (cause) => new DatabaseError(message, { cause }));

// why: Discord API 失敗を DB 失敗と同格の AppError に揃える → ADR-0015
export const fromDiscordPromise = <T>(promise: Promise<T>, message: string): ResultAsync<T, DiscordApiError> =>
  ResultAsync.fromPromise(promise, (cause) => new DiscordApiError(message, { cause }));
