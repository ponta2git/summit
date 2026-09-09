import { randomUUID } from "node:crypto";
import type { ResultNotificationKind } from "@momo/db";
import type { ClaimedResultNotification, ResultNotificationsPort } from "../../src/db/ports.resultNotifications.ts";
import { OUTBOX_MAX_ATTEMPTS, OUTBOX_RETENTION_DELIVERED_MS, OUTBOX_RETENTION_FAILED_MS, RESULT_NOTIFICATION_MAX_JSONB_BYTES } from "../../src/config.ts";
import { NotificationInputError, readNotificationIdentity, validateNewNotification } from "../../src/domain/resultNotificationPayload.ts";
import { ownsNotificationClaim, afterDeliveryFailure } from "../../src/domain/notification.ts";
import { addMs } from "../../src/time/index.ts";
import { buildNotificationLinks } from "../../src/features/result-notifications/links.ts";
import { DEFAULT_CLOCK, recordCall, type AnyCall, type FakeClock } from "./ports.shared.ts";
import { createFakeResultState, semanticJson, type FakeResultEntry } from "./ports.resultNotifications.state.ts";

export interface FakeResultNotificationsPort extends ResultNotificationsPort {
  readonly calls: readonly AnyCall[];
  setTargetAvailable(kind: "match_draft" | "match", id: string, available: boolean): void;
}

export const createFakeResultNotificationsPort = (clock: FakeClock = DEFAULT_CLOCK): FakeResultNotificationsPort => {
  const { entries, settings, available, cancel, reason } = createFakeResultState();
  const calls: AnyCall[] = [];
  const getSetting = (kind: ResultNotificationKind) => {
    const value = settings.get(kind);
    if (!value) { throw new Error("Missing setting"); }
    return structuredClone(value);
  };
  const fenced = (id: string, token: string, now: Date, allowCancelled = false): FakeResultEntry | undefined => {
    const n = entries.get(id);
    return n && ownsNotificationClaim(n, token, now, allowCancelled) ? n : undefined;
  };
  const resetClaim = (n: FakeResultEntry, now: Date, next: Date | null): void => {
    n.status = afterDeliveryFailure(n, next !== null);
    n.parts = n.parts.map(part => part.status === "IN_FLIGHT" ? { ...part, status: n.status === "CANCELLED" ? "CANCELLED" : "PENDING" } : part);
    n.claimToken = null; n.claimExpiresAt = null; n.nextAttemptAt = next ?? now;
    n.terminalAt = n.status === "CANCELLED" ? n.terminalAt : n.status === "FAILED" ? now : null;
  };
  return {
    calls,
    setTargetAvailable: (kind, id, isAvailable) => {
      if (isAvailable) { available.add(`${kind}:${id}`); } else { available.delete(`${kind}:${id}`); }
      for (const n of entries.values()) { const why = reason(n); if (why) { cancel(n, why, clock.now()); } }
    },
    receive: async (rawJson, now) => {
      recordCall(calls, "receive", {});
      let value: unknown;
      try { value = JSON.parse(rawJson); } catch { throw new NotificationInputError("invalid_input"); }
      const identity = readNotificationIdentity(value);
      const canonical = semanticJson(value);
      if (Buffer.byteLength(canonical) > RESULT_NOTIFICATION_MAX_JSONB_BYTES) { throw new NotificationInputError("payload_too_large"); }
      const existing = [...entries.values()].find(n => n.id === identity.notificationId || (n.kind === identity.kind && n.sourceJobId === identity.sourceJobId));
      if (existing) {
        if (existing.id !== identity.notificationId || existing.identity !== canonical) { throw new NotificationInputError("identity_conflict"); }
        return { notificationId: existing.id, disposition: "duplicate", status: existing.status };
      }
      const payload = validateNewNotification(value);
      const n: FakeResultEntry = { id: payload.notificationId, kind: payload.kind, sourceJobId: payload.sourceJobId,
        identity: canonical, payload, status: "PENDING", attemptCount: 0, maxAttempts: OUTBOX_MAX_ATTEMPTS, retryCycle: 0,
        claimToken: null, claimExpiresAt: null, nextAttemptAt: now, terminalAt: null, purgedAt: null,
        cancelReason: null, lastError: null, partCount: 0, rendererVersion: null, deliveryContext: null, parts: [] };
      entries.set(n.id, n);
      const why = reason(n); if (why) { cancel(n, why, now); }
      return { notificationId: n.id, disposition: why ? "cancelled" : "accepted", status: n.status };
    },
    claim: async options => {
      recordCall(calls, "claim", options);
      for (const n of entries.values()) {
        if (n.claimExpiresAt && n.claimExpiresAt <= options.now) {
          resetClaim(n, options.now, options.now);
          if (n.status === "FAILED") { n.lastError = "attempt_limit"; }
        }
      }
      const candidates = [...entries.values()].filter(n => n.status === "PENDING" && n.nextAttemptAt <= options.now && !options.excludeIds?.includes(n.id))
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.id.localeCompare(b.id)).slice(0, options.limit);
      const result: ClaimedResultNotification[] = [];
      for (const n of candidates) {
        if (n.attemptCount >= n.maxAttempts) { n.status = "FAILED"; n.lastError = "attempt_limit"; n.terminalAt = options.now; continue; }
        const why = reason(n); if (why) { cancel(n, why, options.now); continue; }
        n.status = "IN_FLIGHT"; n.claimToken = randomUUID(); n.claimExpiresAt = addMs(options.now, options.claimDurationMs); n.attemptCount += 1;
        result.push(structuredClone({ id: n.id, kind: n.kind, payload: n.payload, claimToken: n.claimToken, attemptCount: n.attemptCount,
          maxAttempts: n.maxAttempts, partCount: n.partCount, rendererVersion: n.rendererVersion, deliveryContext: n.deliveryContext, parts: n.parts }));
      }
      return result;
    },
    plan: async (id, token, options) => {
      const n = fenced(id, token, options.now); if (!n) { return false; }
      if (!Number.isInteger(options.count) || options.count < 1 || options.count > 10_000
        || !Number.isInteger(options.rendererVersion) || options.rendererVersion < 1 || !options.context.channelId) {
        throw new Error("Invalid notification part plan");
      }
      buildNotificationLinks(options.context.webOrigin);
      if (n.partCount > 0) {
        if (n.partCount !== options.count || n.rendererVersion !== options.rendererVersion || semanticJson(n.deliveryContext) !== semanticJson(options.context)) { throw new Error("Plan conflict"); }
        return true;
      }
      n.partCount = options.count; n.rendererVersion = options.rendererVersion; n.deliveryContext = structuredClone(options.context);
      n.parts = Array.from({ length: options.count }, (_, partNo) => ({ partNo, status: "PENDING", attemptCount: 0, deliveredMessageId: null }));
      return true;
    },
    begin: async (id, partNo, token, now) => {
      recordCall(calls, "begin", { id, partNo, now });
      const n = fenced(id, token, now); if (!n) { return false; }
      const why = reason(n); if (why) { cancel(n, why, now); return false; }
      const part = n.parts[partNo];
      if (!part || part.status !== "PENDING" || n.parts.some(p => p.partNo < partNo && p.status !== "DELIVERED")) { return false; }
      n.parts[partNo] = { ...part, status: "IN_FLIGHT", attemptCount: part.attemptCount + 1 };
      return true;
    },
    complete: async (id, partNo, token, messageId, now) => {
      recordCall(calls, "complete", { id, partNo, now });
      const n = fenced(id, token, now, true); const part = n?.parts[partNo];
      if (!n || !part || part.status !== "IN_FLIGHT") { return false; }
      n.parts[partNo] = { ...part, status: "DELIVERED", deliveredMessageId: messageId };
      if (n.status === "CANCELLED") { n.claimToken = null; n.claimExpiresAt = null; }
      else if (n.parts.every(p => p.status === "DELIVERED")) {
        n.status = "DELIVERED"; n.terminalAt = now; n.claimToken = null; n.claimExpiresAt = null; n.lastError = null;
      }
      return true;
    },
    fail: async (id, token, error, next, now) => {
      const n = fenced(id, token, now, true); if (!n) { return false; }
      resetClaim(n, now, next); n.lastError = error; return true;
    },
    renew: async (id, token, now, duration) => {
      recordCall(calls, "renew", { id, now });
      const n = fenced(id, token, now); if (!n) { return false; }
      n.claimExpiresAt = addMs(now, duration); return true;
    },
    getNextDispatchAt: async (excluded = []) => {
      recordCall(calls, "getNextDispatchAt", {});
      return [...entries.values()].filter(n => !excluded.includes(n.id) && !n.purgedAt)
        .map(n => n.status === "PENDING" ? n.nextAttemptAt : n.claimExpiresAt).filter((at): at is Date => at !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    },
    inspect: async id => {
      const n = entries.get(id); if (!n) { return null; }
      return structuredClone({ notificationId: n.id, sourceJobId: n.sourceJobId, kind: n.kind, status: n.status,
        attemptCount: n.attemptCount, maxAttempts: n.maxAttempts, retryCycle: n.retryCycle, nextAttemptAt: n.nextAttemptAt,
        claimExpiresAt: n.claimExpiresAt, cancelReason: n.cancelReason, lastError: n.lastError, purgedAt: n.purgedAt,
        partCount: n.partCount, rendererVersion: n.rendererVersion, parts: n.parts,
        retryable: n.status === "FAILED" && !n.purgedAt && reason(n) === null });
    },
    retry: async (id, now) => {
      const n = entries.get(id); if (!n || n.status !== "FAILED" || n.purgedAt) { return false; }
      const why = reason(n); if (why) { cancel(n, why, now); return false; }
      n.status = "PENDING"; n.attemptCount = 0; n.retryCycle += 1; n.terminalAt = null; n.lastError = null; n.nextAttemptAt = now;
      return true;
    },
    prune: async now => {
      let count = 0;
      for (const n of entries.values()) {
        const keep = n.status === "DELIVERED" ? OUTBOX_RETENTION_DELIVERED_MS : OUTBOX_RETENTION_FAILED_MS;
        if (!n.terminalAt || n.purgedAt || n.claimToken || n.parts.some(p => p.status === "IN_FLIGHT") || now.getTime() - n.terminalAt.getTime() < keep) { continue; }
        n.payload = null; n.deliveryContext = null; n.parts = []; n.purgedAt = now; n.lastError = null; count += 1;
      }
      return count;
    },
    getSetting: async kind => getSetting(kind),
    setSetting: async (kind, enabled, now) => {
      const old = getSetting(kind); const next = { kind, enabled, generation: String(BigInt(old.generation) + (old.enabled === enabled ? 0n : 1n)) };
      settings.set(kind, next);
      if (!enabled) { for (const n of entries.values()) { if (n.kind === kind) { cancel(n, "setting_off", now); } } }
      return structuredClone(next);
    }
  };
};
