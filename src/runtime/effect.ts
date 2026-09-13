import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";

/** Foreign I/O starts inside the Effect; synchronous throws and rejections share its error channel. */
export const promiseCall = <T>(call: () => PromiseLike<T>): Effect.Effect<T, unknown> =>
  Effect.tryPromise({ try: call, catch: error => error });

/** DB/SDK calls without cancellation keep their owner until the actual operation settles. */
export const settledCall = <T>(call: () => PromiseLike<T>): Effect.Effect<T, unknown> =>
  Effect.uninterruptible(promiseCall(call));

/** Preserve the Promise port's original error identity; never render a Cause or FiberFailure to logs. */
export const runPromiseBoundary = async <T, E>(effect: Effect.Effect<T, E>): Promise<T> => {
  // Child fibers inherit this policy: diagnostics go through the application's safe pino boundary.
  const exit = await Effect.runPromiseExit(effect.pipe(Logger.withMinimumLogLevel(LogLevel.None)));
  if (Exit.isSuccess(exit)) { return exit.value; }
  throw Cause.squash(exit.cause);
};
