import type { OutboxEntry, OutboxPort } from "../../src/db/ports.js";
import { recordCall, type AnyCall } from "./ports.shared.js";

type OutboxMaintenancePort = Pick<
  OutboxPort,
  | "requeueFailedChains"
  | "releaseExpiredClaims"
  | "findStranded"
  | "prune"
  | "getMetrics"
  | "getNextDispatchAt"
>;

export const createFakeOutboxMaintenance = (
  byId: Map<string, OutboxEntry>,
  calls: AnyCall[],
  cloneEntry: (entry: OutboxEntry) => OutboxEntry
): OutboxMaintenancePort => ({
  requeueFailedChains: async (now) => {
    recordCall(calls, "requeueFailedChains", { now });
    const failed = Array.from(byId.values()).filter(
      (entry) => entry.status === "FAILED"
    );
    let successorsRequeued = 0;
    for (const entry of Array.from(byId.values())) {
      const followsFailure = failed.some(
        (predecessor) =>
          predecessor.sessionId === entry.sessionId &&
          (predecessor.aggregateRevision < entry.aggregateRevision ||
            (predecessor.aggregateRevision === entry.aggregateRevision &&
              predecessor.ordinal < entry.ordinal))
      );
      if (entry.status === "CANCELLED" && followsFailure) {
        byId.set(entry.id, {
          ...entry,
          status: "PENDING",
          attemptCount: 0,
          lastError: null,
          claimExpiresAt: null,
          claimToken: null,
          nextAttemptAt: now,
          deliveredAt: null,
          deliveredMessageId: null,
          updatedAt: now
        });
        successorsRequeued += 1;
      }
    }
    for (const entry of failed) {
      byId.set(entry.id, {
        ...entry,
        status: "PENDING",
        attemptCount: 0,
        lastError: null,
        claimExpiresAt: null,
        claimToken: null,
        nextAttemptAt: now,
        deliveredAt: null,
        deliveredMessageId: null,
        updatedAt: now
      });
    }
    return {
      deadLettersRequeued: failed.length,
      successorsRequeued
    };
  },
  releaseExpiredClaims: async (now) => {
    recordCall(calls, "releaseExpiredClaims", { now });
    let released = 0;
    for (const entry of byId.values()) {
      if (
        entry.status === "IN_FLIGHT" &&
        entry.claimExpiresAt !== null &&
        entry.claimExpiresAt <= now
      ) {
        byId.set(entry.id, {
          ...entry,
          status: "PENDING",
          claimExpiresAt: null,
          claimToken: null,
          nextAttemptAt: now,
          updatedAt: now
        });
        released += 1;
      }
    }
    return released;
  },
  findStranded: async (threshold) => {
    recordCall(calls, "findStranded", { threshold });
    return Array.from(byId.values())
      .filter(
        (entry) =>
          entry.status === "FAILED" ||
          ((entry.status === "PENDING" || entry.status === "IN_FLIGHT") &&
            entry.attemptCount >= threshold)
      )
      .map(cloneEntry);
  },
  prune: async ({ deliveredOlderThan, failedOlderThan }) => {
    recordCall(calls, "prune", { deliveredOlderThan, failedOlderThan });
    let deliveredPruned = 0;
    let failedPruned = 0;
    let cancelledPruned = 0;
    for (const entry of Array.from(byId.values())) {
      if (
        entry.status === "DELIVERED" &&
        entry.deliveredAt !== null &&
        entry.deliveredAt <= deliveredOlderThan
      ) {
        byId.delete(entry.id);
        deliveredPruned += 1;
      } else if (entry.status === "FAILED" && entry.updatedAt <= failedOlderThan) {
        byId.delete(entry.id);
        failedPruned += 1;
      } else if (
        entry.status === "CANCELLED" &&
        entry.updatedAt <= failedOlderThan
      ) {
        byId.delete(entry.id);
        cancelledPruned += 1;
      }
    }
    return { deliveredPruned, failedPruned, cancelledPruned };
  },
  getMetrics: async (now) => {
    recordCall(calls, "getMetrics", { now });
    let pending = 0;
    let inFlight = 0;
    let failed = 0;
    let oldestPending: Date | null = null;
    let oldestFailed: Date | null = null;
    for (const entry of byId.values()) {
      if (entry.status === "PENDING") {
        pending += 1;
        if (oldestPending === null || entry.createdAt < oldestPending) {
          oldestPending = entry.createdAt;
        }
      } else if (entry.status === "IN_FLIGHT") {
        inFlight += 1;
      } else if (entry.status === "FAILED") {
        failed += 1;
        if (oldestFailed === null || entry.updatedAt < oldestFailed) {
          oldestFailed = entry.updatedAt;
        }
      }
    }
    const ageMs = (date: Date | null): number | null =>
      date === null ? null : Math.max(0, now.getTime() - date.getTime());
    return {
      pending,
      inFlight,
      failed,
      oldestPendingAgeMs: ageMs(oldestPending),
      oldestFailedAgeMs: ageMs(oldestFailed)
    };
  },
  getNextDispatchAt: async (now) => {
    recordCall(calls, "getNextDispatchAt", { now });
    const candidates = Array.from(byId.values())
      .map((entry) => {
        if (entry.status === "PENDING") {return entry.nextAttemptAt;}
        if (entry.status === "IN_FLIGHT") {return entry.claimExpiresAt;}
        return null;
      })
      .filter((date): date is Date => date !== null);
    if (candidates.length === 0) {return null;}
    return candidates.reduce((earliest, current) =>
      current.getTime() < earliest.getTime() ? current : earliest
    );
  }
});
