import { randomUUID } from "node:crypto";

import type {
  EnqueueOutboxInput,
  EnqueueResult,
  OutboxEntry,
  OutboxPort
} from "../../src/db/ports.js";
import { DEFAULT_CLOCK, recordCall, type AnyCall, type FakeClock } from "./ports.shared.js";
import { createFakeOutboxMaintenance } from "./ports.outbox.maintenance.js";

export interface FakeOutboxPort extends OutboxPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listEntries(): ReadonlyArray<OutboxEntry>;
  seedEntry(entry: OutboxEntry): void;
  restoreEntries(entries: readonly OutboxEntry[]): void;
  cancelForSessionIds(
    sessionIds: readonly string[],
    exceptDedupeKey: string,
    now: Date
  ): void;
}

/** In-memory outbox with global dedupe, claims, retry, metrics, and retention semantics. */
export const createFakeOutboxPort = (
  seed: ReadonlyArray<OutboxEntry> = [],
  clock: FakeClock = DEFAULT_CLOCK
): FakeOutboxPort => {
  const calls: AnyCall[] = [];
  const byId = new Map<string, OutboxEntry>(seed.map((entry) => [entry.id, { ...entry }]));
  const cloneEntry = (entry: OutboxEntry): OutboxEntry => ({ ...entry });
  const activeDedupe = (key: string): OutboxEntry | undefined =>
    Array.from(byId.values()).find((entry) => entry.dedupeKey === key);

  return {
    calls,
    listEntries: () => Array.from(byId.values()).map(cloneEntry),
    restoreEntries: (entries) => {
      byId.clear();
      for (const entry of entries) {
        byId.set(entry.id, cloneEntry(entry));
      }
    },
    cancelForSessionIds: (sessionIds, exceptDedupeKey, now) => {
      const ids = new Set(sessionIds);
      for (const entry of byId.values()) {
        if (
          ids.has(entry.sessionId) &&
          entry.dedupeKey !== exceptDedupeKey &&
          (entry.status === "PENDING" ||
            entry.status === "IN_FLIGHT" ||
            entry.status === "FAILED")
        ) {
          byId.set(entry.id, {
            ...entry,
            status: "CANCELLED",
            claimExpiresAt: null,
            claimToken: null,
            updatedAt: now
          });
        }
      }
    },
    seedEntry: (entry) => {
      byId.set(entry.id, { ...entry });
    },
    enqueue: async (input: EnqueueOutboxInput): Promise<EnqueueResult> => {
      recordCall(calls, "enqueue", { input });
      const existing = activeDedupe(input.dedupeKey);
      if (existing) {return { id: existing.id, skipped: true };}
      const orderConflict = Array.from(byId.values()).some(
        (entry) =>
          entry.sessionId === input.sessionId &&
          entry.aggregateRevision === input.aggregateRevision &&
          entry.ordinal === input.ordinal
      );
      if (orderConflict) {
        throw new Error("duplicate outbox Session order");
      }
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
        claimToken: null,
        nextAttemptAt: now,
        deliveredAt: null,
        deliveredMessageId: null,
        aggregateRevision: input.aggregateRevision,
        ordinal: input.ordinal,
        createdAt: now,
        updatedAt: now
      });
      return { id, skipped: false };
    },
    claimNextBatch: async ({ limit, now, claimDurationMs }) => {
      recordCall(calls, "claimNextBatch", { limit, now, claimDurationMs });
      for (const entry of Array.from(byId.values())) {
        const blockedByFailure = Array.from(byId.values()).some(
          (predecessor) =>
            predecessor.sessionId === entry.sessionId &&
            predecessor.status === "FAILED" &&
            (predecessor.aggregateRevision < entry.aggregateRevision ||
              (predecessor.aggregateRevision === entry.aggregateRevision &&
                predecessor.ordinal < entry.ordinal))
        );
        if (
          blockedByFailure &&
          (entry.status === "PENDING" || entry.status === "IN_FLIGHT")
        ) {
          byId.set(entry.id, {
            ...entry,
            status: "CANCELLED",
            claimExpiresAt: null,
            claimToken: null,
            updatedAt: now
          });
        }
      }
      const deliverable = Array.from(byId.values()).filter((entry) =>
        (entry.status === "PENDING" && entry.nextAttemptAt <= now) ||
        (entry.status === "IN_FLIGHT" &&
          entry.claimExpiresAt !== null &&
          entry.claimExpiresAt <= now)
      );
      const candidates = deliverable
        .filter((entry) =>
          !Array.from(byId.values()).some(
            (predecessor) =>
              predecessor.sessionId === entry.sessionId &&
              (predecessor.status === "PENDING" ||
                predecessor.status === "IN_FLIGHT" ||
                predecessor.status === "FAILED") &&
              (predecessor.aggregateRevision < entry.aggregateRevision ||
                (predecessor.aggregateRevision === entry.aggregateRevision &&
                  predecessor.ordinal < entry.ordinal))
          )
        )
        .sort(
          (left, right) =>
            left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() ||
            left.sessionId.localeCompare(right.sessionId) ||
            left.aggregateRevision - right.aggregateRevision ||
            left.ordinal - right.ordinal
        )
        .slice(0, limit);
      const claimToken = randomUUID();
      return candidates.map((entry) => {
        const claimed: OutboxEntry = {
          ...entry,
          status: "IN_FLIGHT",
          attemptCount: entry.attemptCount + 1,
          claimExpiresAt: new Date(now.getTime() + claimDurationMs),
          claimToken,
          updatedAt: now
        };
        byId.set(entry.id, claimed);
        return cloneEntry(claimed);
      });
    },
    markDelivered: async (id, options) => {
      const { deliveredMessageId, now } = options;
      recordCall(calls, "markDelivered", { id, ...options });
      const found = byId.get(id);
      if (
        !found ||
        found.status !== "IN_FLIGHT" ||
        found.claimToken !== options.claimToken
      ) {return false;}
      byId.set(id, {
        ...found,
        status: "DELIVERED",
        deliveredAt: now,
        deliveredMessageId,
        lastError: null,
        claimExpiresAt: null,
        claimToken: null,
        updatedAt: now
      });
      return true;
    },
    markFailed: async (id, options) => {
      const { error, now, nextAttemptAt } = options;
      recordCall(calls, "markFailed", { id, ...options });
      const found = byId.get(id);
      if (
        !found ||
        found.status !== "IN_FLIGHT" ||
        found.claimToken !== options.claimToken
      ) {return false;}
      byId.set(id, {
        ...found,
        status: nextAttemptAt === null ? "FAILED" : "PENDING",
        lastError: error.slice(0, 4000),
        claimExpiresAt: null,
        claimToken: null,
        nextAttemptAt: nextAttemptAt ?? now,
        updatedAt: now
      });
      if (nextAttemptAt === null) {
        for (const successor of byId.values()) {
          if (
            successor.sessionId === found.sessionId &&
            (successor.status === "PENDING" || successor.status === "IN_FLIGHT") &&
            (successor.aggregateRevision > found.aggregateRevision ||
              (successor.aggregateRevision === found.aggregateRevision &&
                successor.ordinal > found.ordinal))
          ) {
            byId.set(successor.id, {
              ...successor,
              status: "CANCELLED",
              claimExpiresAt: null,
              claimToken: null,
              updatedAt: now
            });
          }
        }
      }
      return true;
    },
    ...createFakeOutboxMaintenance(byId, calls, cloneEntry)
  };
};
