import type { ResultAsync } from "neverthrow";

import { AppError, InvariantViolationError, errResult, type AppResult } from "../errors/index.ts";
import { fromAppCall } from "../errors/result.ts";

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

export type SchedulerResult<T> = ResultAsync<T, AppError>;

export interface SchedulerItemIdentity {
  readonly sessionId?: string;
  readonly weekKey?: string;
  readonly outboxId?: string;
}

const runSchedulerBatch = async <TItem, TValue>(
  phase: string,
  items: readonly TItem[],
  run: (item: TItem) => SchedulerResult<TValue>,
  identify: (item: TItem) => SchedulerItemIdentity,
  onFailure: (failure: SchedulerFailure) => void,
  successCount: (value: TValue) => number = () => 1
): Promise<SchedulerBatchReport> => {
  let succeeded = 0;
  const failures: SchedulerFailure[] = [];

  for (const item of items) {
    const identity = identify(item);
    let result: AppResult<TValue>;
    try {
      result = await run(item);
    } catch (cause: unknown) {
      result = errResult(cause instanceof AppError ? cause :
        new InvariantViolationError(`Scheduler operation failed in phase '${phase}'.`, { cause }));
    }
    // Bookkeeping defects invalidate the whole report; they are not recoverable item failures.
    result.match(
      (value) => {
        succeeded += successCount(value);
      },
      (error) => {
        const failure: SchedulerFailure = { phase, error, ...identity };
        failures.push(failure);
        onFailure(failure);
      }
    );
  }

  return {
    processed: items.length,
    succeeded,
    failures
  };
};

export const runSchedulerBatchResult = <TItem, TValue>(
  phase: string,
  items: readonly TItem[],
  run: (item: TItem) => SchedulerResult<TValue>,
  identify: (item: TItem) => SchedulerItemIdentity,
  onFailure: (failure: SchedulerFailure) => void,
  successCount: (value: TValue) => number = () => 1
): SchedulerResult<SchedulerBatchReport> =>
  fromAppCall(
    () => runSchedulerBatch(phase, items, run, identify, onFailure, successCount),
    (cause) => cause instanceof AppError
      ? cause
      : new InvariantViolationError(`Scheduler batch failed in phase '${phase}'.`, { cause })
  );
