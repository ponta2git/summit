import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { AppError, InvariantViolationError } from "../errors/index.ts";

export interface SchedulerFailure {
  readonly phase: string;
  readonly error: AppError;
  readonly sessionId?: string;
  readonly weekKey?: string;
  readonly outboxId?: string;
}

export interface SchedulerBatchReport {
  readonly processed: number;
  readonly succeeded: number;
  readonly failures: readonly SchedulerFailure[];
}

export type SchedulerEffect<T> = Effect.Effect<T, AppError>;

export interface SchedulerItemIdentity {
  readonly sessionId?: string;
  readonly weekKey?: string;
  readonly outboxId?: string;
}

export const runSchedulerBatchEffect = <TItem, TValue>(
  phase: string,
  items: readonly TItem[],
  run: (item: TItem) => SchedulerEffect<TValue>,
  identify: (item: TItem) => SchedulerItemIdentity,
  onFailure: (failure: SchedulerFailure) => void,
  successCount: (value: TValue) => number = () => 1
): SchedulerEffect<SchedulerBatchReport> =>
  Effect.gen(function* () {
    let succeeded = 0;
    const failures: SchedulerFailure[] = [];
    for (const item of items) {
      const identity = identify(item);
      const exit = yield* Effect.exit(Effect.suspend(() => run(item)));
      if (Exit.isSuccess(exit)) {
        succeeded += successCount(exit.value);
        continue;
      }
      // invariant: 停止要求を回復可能な item failure に変えて後続 work を開始しない。
      if (Cause.isInterrupted(exit.cause)) { return yield* Effect.failCause(exit.cause); }
      const cause = Cause.squash(exit.cause);
      const error = cause instanceof AppError ? cause :
        new InvariantViolationError(`Scheduler operation failed in phase '${phase}'.`, { cause });
      const failure: SchedulerFailure = { phase, error, ...identity };
      failures.push(failure);
      onFailure(failure);
    }
    return { processed: items.length, succeeded, failures };
  }).pipe(Effect.catchAllCause(cause => {
    if (Cause.isInterrupted(cause)) { return Effect.failCause(cause); }
    // invariant: 集計・識別・失敗記録の defect は report 全体を無効にする。
    const error = Cause.squash(cause);
    return Effect.fail(error instanceof AppError ? error :
      new InvariantViolationError(`Scheduler batch failed in phase '${phase}'.`, { cause: error }));
  }));
