import { and, eq, exists, lt, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DbLike } from "../rows.ts";
import { discordOutbox } from "../schema.ts";

export interface RequeueFailedOutboxChainsResult {
  readonly deadLettersRequeued: number;
  readonly successorsRequeued: number;
}

const resetForRetry = (now: Date) => ({
  status: "PENDING" as const,
  attemptCount: 0,
  lastError: null,
  claimExpiresAt: null,
  claimToken: null,
  nextAttemptAt: now,
  deliveredAt: null,
  deliveredMessageId: null,
  updatedAt: now
});

/**
 * Re-open dead-lettered Session chains once at process startup.
 *
 * @remarks
 * The operation is deliberately not part of the periodic worker loop: a permanently invalid
 * payload gets one fresh retry cycle per deployment/restart, without becoming a hot retry loop.
 * Successors cancelled by the failed predecessor are restored in the same transaction.
 */
export const requeueFailedOutboxChains = async (
  db: DbLike,
  now: Date
): Promise<RequeueFailedOutboxChainsResult> =>
  db.transaction(async (tx) => {
    const failedPredecessor = alias(discordOutbox, "recovery_failed_predecessor");
    const successors = await tx
      .update(discordOutbox)
      .set(resetForRetry(now))
      .where(
        and(
          eq(discordOutbox.status, "CANCELLED"),
          exists(
            tx
              .select({ id: failedPredecessor.id })
              .from(failedPredecessor)
              .where(
                and(
                  eq(failedPredecessor.sessionId, discordOutbox.sessionId),
                  eq(failedPredecessor.status, "FAILED"),
                  or(
                    lt(failedPredecessor.aggregateRevision, discordOutbox.aggregateRevision),
                    and(
                      eq(failedPredecessor.aggregateRevision, discordOutbox.aggregateRevision),
                      lt(failedPredecessor.ordinal, discordOutbox.ordinal)
                    )
                  )
                )
              )
          )
        )
      )
      .returning({ id: discordOutbox.id });

    const deadLetters = await tx
      .update(discordOutbox)
      .set(resetForRetry(now))
      .where(eq(discordOutbox.status, "FAILED"))
      .returning({ id: discordOutbox.id });

    return {
      deadLettersRequeued: deadLetters.length,
      successorsRequeued: successors.length
    };
  });
