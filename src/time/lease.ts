import { addMs, type Clock } from "./index.ts";

/** Observation taken at the write boundary, before SQL and COMMIT response latency. */
export interface ClaimLease {
  readonly observedAt: Date;
  readonly observedMonotonicMs: number;
  readonly expiresAt: Date;
}

export const monotonicNow = (clock: Clock): number => clock.monotonicNow?.() ?? performance.now();

/** A clock correction must not backdate a command that already reached this process. */
export const notificationCommandNow = (clock: Clock, requestedAt: Date): Date =>
  addMs(requestedAt, Math.max(0, clock.now().getTime() - requestedAt.getTime()));

export const observeClaimLease = (clock: Clock, requestedAt: Date, durationMs: number): ClaimLease => {
  const observedMonotonicMs = monotonicNow(clock);
  const observedAt = notificationCommandNow(clock, requestedAt);
  return { observedAt, observedMonotonicMs, expiresAt: addMs(observedAt, durationMs) };
};

/** Both clocks can shorten ownership; neither a wall-clock rollback nor a late reply can extend it. */
export const claimLeaseRemainingMs = (lease: ClaimLease, clock: Clock): number => Math.min(
  lease.expiresAt.getTime() - clock.now().getTime(),
  lease.expiresAt.getTime() - lease.observedAt.getTime() - Math.max(0, monotonicNow(clock) - lease.observedMonotonicMs)
);
