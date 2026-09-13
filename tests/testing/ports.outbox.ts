import { checkpointMap } from "./transactions.ts";
import { randomUUID } from "node:crypto";

import type {
  EnqueueOutboxInput,
  EnqueueResult,
  OutboxEntry,
  OutboxPort
} from "../../src/db/ports.js";
import { DEFAULT_CLOCK, recordCall, type AnyCall, type FakeClock } from "./ports.shared.js";
import { createFakeOutboxMaintenance } from "./ports.outbox.maintenance.js";
import { OUTBOX_MAX_ATTEMPTS } from "../../src/config.js";

export interface FakeOutboxPort extends OutboxPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listEntries(): ReadonlyArray<OutboxEntry>;
  seedEntry(entry: OutboxEntry): void;
  checkpoint(): () => void;
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
  const byId = new Map<string, OutboxEntry>(seed.map((entry) => [entry.id, structuredClone(entry)]));
  const sendingTokens = new Map<string, string>();
  const cancellationReasons = new Map<string, string>();
  const purgedIdentities = new Map<string, string>();
  const cloneEntry = (entry: OutboxEntry): OutboxEntry => structuredClone(entry);
  const activeDedupe = (key: string): OutboxEntry | undefined =>
    Array.from(byId.values()).find((entry) => entry.dedupeKey === key);

  return {
    calls,
    listEntries: () => Array.from(byId.values()).map(cloneEntry),
    checkpoint: () => {
      const restores = [checkpointMap(byId), checkpointMap(sendingTokens), checkpointMap(cancellationReasons), checkpointMap(purgedIdentities)];
      return () => { for (const restore of restores) { restore(); } };
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
          cancellationReasons.set(entry.id, "manual_skip");
          const sending = sendingTokens.get(entry.id) === entry.claimToken;
          byId.set(entry.id, {
            ...entry,
            status: "CANCELLED",
            claimExpiresAt: sending ? entry.claimExpiresAt : null,
            claimToken: sending ? entry.claimToken : null,
            updatedAt: now
          });
        }
      }
    },
    seedEntry: (entry) => {
      byId.set(entry.id, cloneEntry(entry));
    },
    enqueue: async (input: EnqueueOutboxInput): Promise<EnqueueResult> => {
      recordCall(calls, "enqueue", { input });
      const existing = activeDedupe(input.dedupeKey);
      if (existing) {return { id: existing.id, skipped: true };}
      const purgedId = purgedIdentities.get(input.dedupeKey);
      if (purgedId) {return { id: purgedId, skipped: true };}
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
        payload: structuredClone(input.payload),
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
      for (const entry of byId.values()) {
        if (entry.status === "IN_FLIGHT" && entry.claimExpiresAt !== null && entry.claimExpiresAt <= now) {
          byId.set(entry.id, {
            ...entry, status: entry.attemptCount >= OUTBOX_MAX_ATTEMPTS ? "FAILED" : "PENDING",
            claimToken: null, claimExpiresAt: null, nextAttemptAt: now, updatedAt: now
          });
          sendingTokens.delete(entry.id);
        }
      }
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
          cancellationReasons.set(entry.id, "predecessor_failed");
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
        sendingTokens.delete(entry.id);
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
    beginDelivery: async (id, options) => {
      recordCall(calls, "beginDelivery", { id, ...options });
      const found = byId.get(id);
      if (!found || found.status !== "IN_FLIGHT" || found.claimToken !== options.claimToken
        || found.claimExpiresAt === null || found.claimExpiresAt <= options.now || sendingTokens.has(id)) {
        return false;
      }
      sendingTokens.set(id, options.claimToken);
      return true;
    },
    markDelivered: async (id, options) => {
      const { deliveredMessageId, now } = options;
      recordCall(calls, "markDelivered", { id, ...options });
      const found = byId.get(id);
      if (
        !found ||
        (found.status !== "IN_FLIGHT" && found.status !== "CANCELLED") ||
        found.claimToken !== options.claimToken ||
        found.claimExpiresAt === null || found.claimExpiresAt <= now ||
        sendingTokens.get(id) !== options.claimToken
      ) {return false;}
      sendingTokens.delete(id);
      byId.set(id, {
        ...found,
        status: found.status === "CANCELLED" ? "CANCELLED" : "DELIVERED",
        deliveredAt: found.status === "CANCELLED" ? null : now,
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
        (found.status !== "IN_FLIGHT" && found.status !== "CANCELLED") ||
        found.claimToken !== options.claimToken ||
        found.claimExpiresAt === null || found.claimExpiresAt <= now
      ) {return false;}
      sendingTokens.delete(id);
      const failed = nextAttemptAt === null || found.attemptCount >= OUTBOX_MAX_ATTEMPTS;
      byId.set(id, {
        ...found,
        status: found.status === "CANCELLED" ? "CANCELLED" : failed ? "FAILED" : "PENDING",
        lastError: error.slice(0, 4000),
        claimExpiresAt: null,
        claimToken: null,
        nextAttemptAt: nextAttemptAt ?? now,
        updatedAt: now
      });
      if (failed && found.status !== "CANCELLED") {
        for (const successor of byId.values()) {
          if (
            successor.sessionId === found.sessionId &&
            (successor.status === "PENDING" || successor.status === "IN_FLIGHT") &&
            (successor.aggregateRevision > found.aggregateRevision ||
              (successor.aggregateRevision === found.aggregateRevision &&
                successor.ordinal > found.ordinal))
          ) {
            cancellationReasons.set(successor.id, "predecessor_failed");
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
    ...createFakeOutboxMaintenance(byId, calls, cloneEntry, cancellationReasons, purgedIdentities, sendingTokens)
  };
};
