import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { DbLike } from "../rows.js";
import { discordOutbox } from "../schema.js";
import type {
  EnqueueOutboxInput,
  EnqueueResult
} from "./outbox.types.js";

export type {
  EnqueueOutboxInput,
  EnqueueResult,
  OutboxEntry,
  OutboxPayload
} from "./outbox.types.js";
export {
  findStrandedOutboxEntries,
  getNextOutboxDispatchAt,
  getOutboxMetrics,
  pruneOutbox,
  type OutboxMetricsResult,
  type PruneOutboxResult
} from "./outbox.metrics.js";
export {
  claimNextOutboxBatch,
  releaseExpiredOutboxClaims
} from "./outbox.claim.js";
export {
  markOutboxDelivered,
  markOutboxFailed
} from "./outbox.delivery.js";
export {
  requeueFailedOutboxChains,
  type RequeueFailedOutboxChainsResult
} from "./outbox.recovery.js";

/** Insert an outbox row; idempotent across every status for the dedupe key. */
export const enqueueOutbox = async (
  db: DbLike,
  input: EnqueueOutboxInput
): Promise<EnqueueResult> => {
  const id = randomUUID();
  const rows = await db
    .insert(discordOutbox)
    .values({
      id,
      kind: input.kind,
      sessionId: input.sessionId,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      aggregateRevision: input.aggregateRevision,
      ordinal: input.ordinal
    })
    .onConflictDoNothing({ target: discordOutbox.dedupeKey })
    .returning({ id: discordOutbox.id });
  if (rows[0]) {return { id: rows[0].id, skipped: false };}

  const existing = await db
    .select({ id: discordOutbox.id })
    .from(discordOutbox)
    .where(eq(discordOutbox.dedupeKey, input.dedupeKey))
    .limit(1);
  return { id: existing[0]?.id ?? id, skipped: true };
};
