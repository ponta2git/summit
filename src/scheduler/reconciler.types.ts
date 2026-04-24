export interface ReconcileReport {
  readonly cancelledPromoted: number;
  readonly askCreated: number;
  readonly messageResent: number;
  readonly staleClaimReclaimed: number;
  readonly outboxClaimReleased: number;
}

export type ReconcileScope = "startup" | "tick" | "reconnect";
