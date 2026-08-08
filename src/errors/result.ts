import { ResultAsync, errAsync, okAsync } from "neverthrow";
import {
  AppError,
  DatabaseError,
  DiscordApiError,
  type AppResult
} from "./index.ts";

export const toResultAsync = <T, E extends AppError>(result: AppResult<T, E>): ResultAsync<T, E> =>
  result.match(
    (value) => okAsync(value),
    (error) => errAsync(error),
  );

export const unwrapResultAsync = async <T, E>(result: ResultAsync<T, E>): Promise<T> =>
  result.match(
    (value) => value,
    (error) => { throw error; }
  );

export const fromDatabasePromise = <T>(promise: Promise<T>, message: string): ResultAsync<T, DatabaseError> =>
  ResultAsync.fromPromise(promise, (cause) => new DatabaseError(message, { cause }));

export const fromDatabaseCall = <T>(
  call: () => Promise<T>,
  message: string
): ResultAsync<T, DatabaseError> =>
  ResultAsync.fromThrowable(call, (cause) => new DatabaseError(message, { cause }))();

// why: Discord API 失敗を DB 失敗と同格の AppError に揃える → ADR-0015
export const fromDiscordPromise = <T>(promise: Promise<T>, message: string): ResultAsync<T, DiscordApiError> =>
  ResultAsync.fromPromise(promise, (cause) => new DiscordApiError(message, { cause }));

export const fromDiscordCall = <T>(
  call: () => Promise<T>,
  message: string
): ResultAsync<T, DiscordApiError> =>
  ResultAsync.fromThrowable(call, (cause) => new DiscordApiError(message, { cause }))();

export const fromAppCall = <T>(
  call: () => Promise<T>,
  mapError: (cause: unknown) => AppError
): ResultAsync<T, AppError> => ResultAsync.fromThrowable(call, mapError)();

export const mapDatabaseError = (message: string) => (cause: unknown): AppError =>
  cause instanceof AppError ? cause : new DatabaseError(message, { cause });
