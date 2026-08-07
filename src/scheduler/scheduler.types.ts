import type { ResultAsync } from "neverthrow";

import type { AppError } from "../errors/index.js";

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
