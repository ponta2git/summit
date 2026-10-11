import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as References from "effect/References";
import * as Result from "effect/Result";
import { errorFromCause, findExpectedError } from "./cause.ts";

/** Foreign I/O starts inside the Effect; synchronous throws and rejections share its error channel. */
export const promiseCall = <T>(call: () => PromiseLike<T>): Effect.Effect<T, unknown> =>
  Effect.tryPromise({ try: call, catch: error => error });

/** DB/SDK calls without cancellation keep their owner until the actual operation settles. */
export const settledCall = <T>(call: () => PromiseLike<T>): Effect.Effect<T, unknown> =>
  Effect.uninterruptible(promiseCall(call));

/** Keep defects and interruptions outside recovery, including failures combined with cleanup defects. */
export const catchExpectedError = <A, E, R, B, E2, R2>(
  effect: Effect.Effect<A, E, R>,
  recover: (error: E) => Effect.Effect<B, E2, R2>
): Effect.Effect<A | B, E | E2, R | R2> =>
  Effect.catchCause(effect, (cause): Effect.Effect<B, E | E2, R2> => {
    const error = findExpectedError(cause);
    return Result.isSuccess(error) ? recover(error.success) : Effect.failCause(error.failure);
  });

const runBoundaryExit = <T, E>(effect: Effect.Effect<T, E>): Promise<Exit.Exit<T, E>> =>
  // Child fibers inherit this policy: diagnostics go through the application's safe pino boundary.
  Effect.runPromiseExit(effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")));

/** Preserve original single-error identity; never render a Cause to logs. */
export const runPromiseBoundary = async <T, E>(effect: Effect.Effect<T, E>): Promise<T> => {
  const exit = await runBoundaryExit(effect);
  if (Exit.isSuccess(exit)) { return exit.value; }
  throw errorFromCause(exit.cause);
};

/** Return expected failures as values without hiding defects or interruptions from the Promise owner. */
export const runPromiseResultBoundary = async <T, E>(effect: Effect.Effect<T, E>): Promise<Result.Result<T, E>> => {
  const exit = await runBoundaryExit(effect);
  if (Exit.isSuccess(exit)) { return Result.succeed(exit.value); }
  const error = findExpectedError(exit.cause);
  if (Result.isSuccess(error)) { return Result.fail(error.success); }
  throw errorFromCause(error.failure);
};
