export interface ReconcileReport {
  readonly cancelledPromoted: number;
  readonly askCreated: number;
  readonly messageIntentsQueued: number;
  readonly outboxClaimReleased: number;
  readonly outboxDeadLettersRequeued: number;
  readonly outboxSuccessorsRequeued: number;
}

export type ReconcileScope = "startup" | "reconnect";
