import { Cause, Effect, Exit } from "effect";

/** Foreign I/O starts inside the Effect; synchronous throws and rejections share its error channel. */
export const promiseCall = <T>(call: () => PromiseLike<T>): Effect.Effect<T, unknown> =>
  Effect.tryPromise({ try: call, catch: error => error });

/** DB/SDK calls without cancellation keep their owner until the actual operation settles. */
export const settledCall = <T>(call: () => PromiseLike<T>): Effect.Effect<T, unknown> =>
  Effect.uninterruptible(promiseCall(call));

/** Preserve the Promise port's original error identity; never render a Cause or FiberFailure to logs. */
export const runPromiseBoundary = async <T, E>(effect: Effect.Effect<T, E>): Promise<T> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) { return exit.value; }
  throw Cause.squash(exit.cause);
};
