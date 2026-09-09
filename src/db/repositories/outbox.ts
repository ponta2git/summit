import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbLike } from "../rows.ts";
import type { EnqueueOutboxInput, EnqueueResult } from "./outbox.types.ts";

export type { EnqueueOutboxInput, EnqueueResult, OutboxEntry, OutboxPayload } from "./outbox.types.ts";
export { findStrandedOutboxEntries, getNextOutboxDispatchAt, getOutboxMetrics, pruneOutbox } from "./outbox.metrics.ts";
export { claimNextOutboxBatch, releaseExpiredOutboxClaims } from "./outbox.claim.ts";
export { beginOutboxDelivery, markOutboxDelivered, markOutboxFailed } from "./outbox.delivery.ts";
export { requeueFailedOutboxChains } from "./outbox.recovery.ts";

/** Persist attendance context and shared delivery state in the caller's transaction. */
export const enqueueOutbox = async (
  db: Pick<DbLike, "execute">,
  input: EnqueueOutboxInput
): Promise<EnqueueResult> => {
  const [row] = await db.execute<{ notification_id: string; skipped: boolean }>(sql`
    SELECT * FROM public.enqueue_discord_attendance_notification(
      ${randomUUID()}, ${input.sessionId}, ${JSON.stringify(input.payload)}::jsonb,
      ${input.dedupeKey}, ${input.aggregateRevision}::bigint, ${input.ordinal}::smallint
    )
  `);
  if (!row) {
    throw new Error("Attendance notification was not persisted");
  }
  return { id: row.notification_id, skipped: row.skipped };
};
