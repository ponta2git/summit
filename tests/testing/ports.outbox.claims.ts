import type { OutboxEntry } from "../../src/db/ports.ts";
import { OUTBOX_MAX_ATTEMPTS } from "../../src/config.ts";
import { NOTIFICATION_MAINTENANCE_BATCH_SIZE } from "../../src/notifications/config.ts";

export const releaseExpiredFakeOutboxClaims = (
  byId: Map<string, OutboxEntry>, sendingTokens: Map<string, string>, now: Date
): number => {
  const expired = [...byId.values()].filter(entry => (entry.status === "IN_FLIGHT" || entry.status === "CANCELLED")
    && entry.claimExpiresAt !== null && entry.claimExpiresAt <= now)
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, NOTIFICATION_MAINTENANCE_BATCH_SIZE);
  for (const entry of expired) {
    const status = entry.status === "CANCELLED" ? "CANCELLED" : entry.attemptCount >= OUTBOX_MAX_ATTEMPTS ? "FAILED" : "PENDING";
    byId.set(entry.id, { ...entry, status, claimExpiresAt: null, claimToken: null,
      nextAttemptAt: now, updatedAt: now, ...(status === "FAILED" ? { lastError: "attempt_limit" } : {}) });
    sendingTokens.delete(entry.id);
  }
  return expired.length;
};

export const cancelFailedFakeOutboxSuccessors = (
  byId: Map<string, OutboxEntry>, reasons: Map<string, string>, sendingTokens: Map<string, string>, now: Date
): void => {
  const entries = [...byId.values()];
  const successors = entries.filter(entry => (entry.status === "PENDING" || entry.status === "IN_FLIGHT")
    && entries.some(previous => previous.sessionId === entry.sessionId && previous.status === "FAILED"
      && (previous.aggregateRevision < entry.aggregateRevision
        || (previous.aggregateRevision === entry.aggregateRevision && previous.ordinal < entry.ordinal))))
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, NOTIFICATION_MAINTENANCE_BATCH_SIZE);
  for (const entry of successors) {
    const sending = sendingTokens.get(entry.id) === entry.claimToken;
    reasons.set(entry.id, "predecessor_failed");
    byId.set(entry.id, { ...entry, status: "CANCELLED", updatedAt: now,
      claimToken: sending ? entry.claimToken : null, claimExpiresAt: sending ? entry.claimExpiresAt : null });
  }
};
