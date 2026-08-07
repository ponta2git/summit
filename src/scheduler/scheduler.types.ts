import type { ResultAsync } from "neverthrow";

import { AppError, InvariantViolationError } from "../errors/index.js";
import { fromAppCall } from "../errors/result.js";

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

export const runSchedulerBatch = async <TItem, TValue>(
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
    let result: SchedulerResult<TValue>;
    try {
      result = run(item);
    } catch (cause: unknown) {
      const failure: SchedulerFailure = {
        phase,
        error: new InvariantViolationError(`Scheduler operation threw in phase '${phase}'.`, { cause }),
        ...identity
      };
      failures.push(failure);
      onFailure(failure);
      continue;
    }
    await result.match(
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
