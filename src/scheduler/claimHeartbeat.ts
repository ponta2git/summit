import * as Effect from "effect/Effect";
import { settledCall } from "../runtime/effect.ts";

/** Own lease renewal until delivery and every started renewal have settled. */
export const withClaimHeartbeat = <T, E>(options: {
  readonly intervalMs: number;
  readonly renew: () => Promise<boolean>;
  readonly onLost: (reason: "lost" | "uncertain") => void;
}, run: (isClaimLost: () => boolean) => Effect.Effect<T, E>): Effect.Effect<T, E> => Effect.suspend(() => {
  let lost = false;
  let finished = false;
  const heartbeat = Effect.gen(function* () {
    while (!lost) {
      yield* Effect.sleep(options.intervalMs);
      // invariant: PostgreSQL Promise は中断できない。scope を閉じても実際の更新完了まで所有する。
      const renewed = yield* settledCall(options.renew).pipe(Effect.match({
        onFailure: () => { if (!finished) { options.onLost("uncertain"); } return false; },
        onSuccess: accepted => {
          if (!accepted && !finished) { options.onLost("lost"); }
          return accepted;
        }
      }));
      lost ||= !renewed;
    }
  });
  return Effect.scoped(Effect.gen(function* () {
    yield* Effect.forkScoped(heartbeat);
    return yield* run(() => lost).pipe(Effect.ensuring(Effect.sync(() => { finished = true; })));
  }));
});
