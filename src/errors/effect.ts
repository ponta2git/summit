import * as Effect from "effect/Effect";
import { AppError, DatabaseError, DiscordApiError } from "./index.ts";
import { settledCall } from "../runtime/effect.ts";

/** External I/O is lazy and remains owned until its underlying Promise settles. */
export const fromDatabaseCall = <T>(
  call: () => Promise<T>,
  message: string
): Effect.Effect<T, DatabaseError> =>
  settledCall(call).pipe(Effect.mapError(cause => new DatabaseError(message, { cause })));

export const fromDiscordCall = <T>(
  call: () => Promise<T>,
  message: string
): Effect.Effect<T, DiscordApiError> =>
  settledCall(call).pipe(Effect.mapError(cause => new DiscordApiError(message, { cause })));

export const fromAppCall = <T>(
  call: () => Promise<T>,
  mapError: (cause: unknown) => AppError
): Effect.Effect<T, AppError> => settledCall(call).pipe(Effect.mapError(mapError));

export const mapDatabaseError = (message: string) => (cause: unknown): AppError =>
  cause instanceof AppError ? cause : new DatabaseError(message, { cause });
