import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { settledCall } from "../runtime/effect.ts";

/** Own lease renewal until delivery and every started renewal have settled. */
export const withClaimHeartbeat = <T, E>(options: {
  readonly intervalMs: number;
  readonly renew: () => Promise<boolean>;
  readonly onLost: (reason: "lost" | "uncertain") => void;
}, run: (isClaimLost: () => boolean) => Effect.Effect<T, E>): Effect.Effect<T, E> => Effect.suspend(() => {
  let lost = false;
  let finished = false;
  let heartbeatFailure: Cause.Cause<never> | undefined;
  const heartbeat = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(options.intervalMs);
      // invariant: PostgreSQL Promise は中断できない。scope を閉じても実際の更新完了まで所有する。
      yield* settledCall(options.renew).pipe(Effect.match({
        onFailure: () => {
          lost = true;
          if (!finished) { options.onLost("uncertain"); }
        },
        onSuccess: accepted => {
          lost ||= !accepted;
          if (!accepted && !finished) { options.onLost("lost"); }
        }
      }));
      if (lost) { return; }
    }
  }).pipe(Effect.onExit(exit => Effect.sync(() => {
    if (Exit.isFailure(exit)) {
      lost = true;
      // invariant: scope close による中断以外の失敗は、配送の settlement 後に owner へ返す。
      if (!finished || !Cause.hasInterruptsOnly(exit.cause)) { heartbeatFailure = exit.cause; }
    }
  })));
  return Effect.scoped(Effect.gen(function* () {
    yield* Effect.forkScoped(heartbeat);
    return yield* Effect.suspend(() => run(() => lost)).pipe(Effect.ensuring(Effect.sync(() => { finished = true; })));
  })).pipe(Effect.ensuring(Effect.suspend(() => heartbeatFailure
    ? Effect.failCause(heartbeatFailure)
    : Effect.void)));
});
