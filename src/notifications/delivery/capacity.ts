import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { InvariantViolationError } from "../../errors/index.ts";

export interface DeliveryBudget {
  readonly slots: number;
  readonly payloadBytes: number;
  readonly activeIds: readonly string[];
  readonly allowOversized: boolean;
}

export interface DeliveryExecution {
  readonly isStopping: () => boolean;
}

export interface DeliveryCapacity {
  snapshot(): DeliveryBudget;
  /** Register before starting work; only the owner can release a reservation. */
  start<E>(id: string, payloadBytes: number, work: (execution: DeliveryExecution) => Effect.Effect<void, E>): Effect.Effect<Fiber.Fiber<void, E>>;
  stop(): void;
  isStopping(): boolean;
  drain(): Effect.Effect<void>;
  close(): Effect.Effect<void>;
}

/** Own logical delivery reservations and fibers independently of notification kinds. */
export const createDeliveryCapacity = (options: {
  readonly slots: number;
  readonly payloadBytes?: number;
  readonly onSettled?: (id: string, exit: Exit.Exit<void, unknown>) => void;
}): DeliveryCapacity => {
  const scope = Scope.makeUnsafe();
  const active = new Map<string, { readonly payloadBytes: number; readonly completed: Deferred.Deferred<void> }>();
  let stopped = false;
  const snapshot = (): DeliveryBudget => ({
    slots: options.slots - active.size,
    payloadBytes: (options.payloadBytes ?? Infinity) - [...active.values()].reduce((sum, item) => sum + item.payloadBytes, 0),
    activeIds: [...active.keys()],
    allowOversized: active.size === 0
  });
  return {
    snapshot,
    isStopping: () => stopped,
    stop: () => { stopped = true; },
    start: <E>(id: string, payloadBytes: number, work: (execution: DeliveryExecution) => Effect.Effect<void, E>): Effect.Effect<Fiber.Fiber<void, E>> =>
      Effect.uninterruptible(Effect.gen(function* () {
        const completed = yield* Effect.sync(() => {
          const available = snapshot();
          if (stopped || active.has(id) || available.slots <= 0 || payloadBytes < 0 || !Number.isFinite(payloadBytes)
            || (payloadBytes > available.payloadBytes && !available.allowOversized)) {
            throw new InvariantViolationError("Invalid delivery capacity reservation.");
          }
          const settlement = Deferred.makeUnsafe<void>();
          active.set(id, { payloadBytes, completed: settlement });
          return settlement;
        });
        const execution: DeliveryExecution = { isStopping: () => stopped };
        const owned = Effect.suspend(() => work(execution)).pipe(Effect.onExit(exit =>
          Effect.sync(() => { active.delete(id); options.onSettled?.(id, exit); })
            .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)))));
        // invariant: 子の実行前に台帳へ登録。開始済み I/O の中断方針は配送方式が所有する。
        return yield* Effect.forkIn(owned, scope, { startImmediately: true, uninterruptible: false });
      })),
    drain: () => Effect.suspend(() => Effect.asVoid(Effect.forEach([...active.values()], item => Deferred.await(item.completed), { concurrency: "unbounded" }))),
    close: () => Effect.suspend(() => { stopped = true; return Scope.close(scope, Exit.void); })
  };
};
