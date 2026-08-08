import type { SchedulerFailure } from "./scheduler.types.ts";

export interface ReconcileReport {
  readonly cancelledPromoted: number;
  readonly askCreated: number;
  readonly messageIntentsQueued: number;
  readonly outboxClaimReleased: number;
  readonly outboxDeadLettersRequeued: number;
  readonly outboxSuccessorsRequeued: number;
  readonly failures: readonly SchedulerFailure[];
}

export type ReconcileScope = "startup" | "reconnect";
