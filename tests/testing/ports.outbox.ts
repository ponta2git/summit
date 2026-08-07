import { randomUUID } from "node:crypto";

import type {
  EnqueueOutboxInput,
  EnqueueResult,
  OutboxEntry,
  OutboxPort
} from "../../src/db/ports.js";
import { DEFAULT_CLOCK, recordCall, type AnyCall, type FakeClock } from "./ports.shared.js";

export interface FakeOutboxPort extends OutboxPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listEntries(): ReadonlyArray<OutboxEntry>;
  seedEntry(entry: OutboxEntry): void;
}

/** In-memory outbox with active dedupe, claims, retry, metrics, and retention semantics. */
export const createFakeOutboxPort = (
  seed: ReadonlyArray<OutboxEntry> = [],
  clock: FakeClock = DEFAULT_CLOCK
): FakeOutboxPort => {
  const calls: AnyCall[] = [];
  const byId = new Map<string, OutboxEntry>(seed.map((entry) => [entry.id, { ...entry }]));
  const cloneEntry = (entry: OutboxEntry): OutboxEntry => ({ ...entry });
  const activeDedupe = (key: string): OutboxEntry | undefined =>
    Array.from(byId.values()).find(
      (entry) => entry.dedupeKey === key && entry.status !== "FAILED"
    );

  return {
    calls,
    listEntries: () => Array.from(byId.values()).map(cloneEntry),
    seedEntry: (entry) => {
      byId.set(entry.id, { ...entry });
    },
    enqueue: async (input: EnqueueOutboxInput): Promise<EnqueueResult> => {
      recordCall(calls, "enqueue", { input });
      const existing = activeDedupe(input.dedupeKey);
      if (existing) {return { id: existing.id, skipped: true };}
      const id = randomUUID();
      const now = clock.now();
      byId.set(id, {
        id,
        kind: input.kind,
        sessionId: input.sessionId,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        status: "PENDING",
        attemptCount: 0,
        lastError: null,
        claimExpiresAt: null,
        nextAttemptAt: now,
        deliveredAt: null,
        deliveredMessageId: null,
        createdAt: now,
        updatedAt: now
      });
      return { id, skipped: false };
    },
    claimNextBatch: async ({ limit, now, claimDurationMs }) => {
      recordCall(calls, "claimNextBatch", { limit, now, claimDurationMs });
      const candidates = Array.from(byId.values())
        .filter((entry) =>
          (entry.status === "PENDING" && entry.nextAttemptAt <= now) ||
          (entry.status === "IN_FLIGHT" &&
            entry.claimExpiresAt !== null &&
            entry.claimExpiresAt <= now)
        )
        .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime())
        .slice(0, limit);
      return candidates.map((entry) => {
        const claimed: OutboxEntry = {
          ...entry,
          status: "IN_FLIGHT",
          attemptCount: entry.attemptCount + 1,
          claimExpiresAt: new Date(now.getTime() + claimDurationMs),
          updatedAt: now
        };
        byId.set(entry.id, claimed);
        return cloneEntry(claimed);
      });
    },
    markDelivered: async (id, { deliveredMessageId, now }) => {
      recordCall(calls, "markDelivered", { id, deliveredMessageId, now });
      const found = byId.get(id);
      if (!found || found.status !== "IN_FLIGHT") {return false;}
      byId.set(id, {
        ...found,
        status: "DELIVERED",
        deliveredAt: now,
        deliveredMessageId,
        claimExpiresAt: null,
        updatedAt: now
      });
      return true;
    },
    markFailed: async (id, { error, now, nextAttemptAt }) => {
      recordCall(calls, "markFailed", { id, error, now, nextAttemptAt });
      const found = byId.get(id);
      if (!found || found.status !== "IN_FLIGHT") {return false;}
      byId.set(id, {
        ...found,
        status: nextAttemptAt === null ? "FAILED" : "PENDING",
        lastError: error.slice(0, 4000),
        claimExpiresAt: null,
        nextAttemptAt: nextAttemptAt ?? now,
        updatedAt: now
      });
      return true;
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
        }
      }
      return { deliveredPruned, failedPruned };
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
  };
};
