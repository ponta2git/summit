import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { discordNotifications, discordNotificationAttendance, discordNotificationParts } from "../schema.ts";
import type { NotificationDb } from "./notifications.storage.ts";
import type { DbLike } from "../rows.ts";
import { normalizeNotificationJson } from "./notifications.hash.ts";
import type { EnqueueOutboxInput, EnqueueResult } from "./outbox.types.ts";

export type { EnqueueOutboxInput, EnqueueResult, OutboxEntry, OutboxPayload } from "./outbox.types.ts";
export { findStrandedOutboxEntries, getNextOutboxDispatchAt, getOutboxMetrics, pruneOutbox } from "./outbox.metrics.ts";
export { claimNextOutboxBatch, releaseExpiredOutboxClaims } from "./outbox.claim.ts";
export { beginOutboxDelivery, markOutboxDelivered, markOutboxFailed } from "./outbox.delivery.ts";
export { requeueFailedOutboxChains } from "./outbox.recovery.ts";

/** Persist attendance context and shared delivery state in the caller's transaction. */
export const enqueueOutboxInTransaction = async (
  db: NotificationDb,
  input: EnqueueOutboxInput
): Promise<EnqueueResult> => {
  const normalized = await normalizeNotificationJson(db, JSON.stringify(input.payload));
  const [inserted] = await db.insert(discordNotifications).values({
    id: randomUUID(), family: "attendance", kind: input.kind, dedupeKey: input.dedupeKey,
    payload: input.payload, payloadHash: normalized.hash, partCount: 1, rendererVersion: 1
  }).onConflictDoNothing({ target: discordNotifications.dedupeKey }).returning({ id: discordNotifications.id });
  if (!inserted) {
    const [existing] = await db.select({ id: discordNotifications.id }).from(discordNotifications)
      .where(and(eq(discordNotifications.dedupeKey, input.dedupeKey), eq(discordNotifications.family, "attendance")));
    if (!existing) { throw new Error("Attendance notification identity conflict"); }
    return { id: existing.id, skipped: true };
  }
  await db.insert(discordNotificationAttendance).values({
    notificationId: inserted.id, sessionId: input.sessionId,
    aggregateRevision: input.aggregateRevision, ordinal: input.ordinal
  });
  await db.insert(discordNotificationParts).values({ notificationId: inserted.id, partNo: 0 });
  return { id: inserted.id, skipped: false };
};

export const enqueueOutbox = (db: DbLike, input: EnqueueOutboxInput): Promise<EnqueueResult> =>
  db.transaction(tx => enqueueOutboxInTransaction(tx, input));
