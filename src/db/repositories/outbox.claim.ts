import { randomUUID } from "node:crypto";

import {
  and,
  eq,
  exists,
  inArray,
  lt,
  lte,
  notExists,
  or,
  sql
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { addMs } from "../../time/index.ts";
import type { DbLike } from "../rows.ts";
import { discordOutbox } from "../schema.ts";
import { mapOutboxRow, type OutboxEntry } from "./outbox.types.ts";

/** Claim a fenced, per-session ordered batch and cancel successors of dead letters. */
export const claimNextOutboxBatch = async (
  db: DbLike,
  options: { readonly limit: number; readonly now: Date; readonly claimDurationMs: number }
): Promise<readonly OutboxEntry[]> => {
  const claimExpiresAt = addMs(options.now, options.claimDurationMs);
  const claimToken = randomUUID();
  return db.transaction(async (tx) => {
    const failedPredecessor = alias(discordOutbox, "failed_outbox_predecessor");
    await tx
      .update(discordOutbox)
      .set({
        status: "CANCELLED",
        claimExpiresAt: null,
        claimToken: null,
        updatedAt: options.now
      })
      .where(
        and(
          inArray(discordOutbox.status, ["PENDING", "IN_FLIGHT"]),
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
      );

    const predecessor = alias(discordOutbox, "outbox_predecessor");
    const due = or(
      and(
        eq(discordOutbox.status, "PENDING"),
        lte(discordOutbox.nextAttemptAt, options.now)
      ),
      and(
        eq(discordOutbox.status, "IN_FLIGHT"),
        lte(discordOutbox.claimExpiresAt, options.now)
      )
    );
    const candidates = await tx
      .select({ id: discordOutbox.id })
      .from(discordOutbox)
      .where(
        and(
          due,
          notExists(
            tx
              .select({ id: predecessor.id })
              .from(predecessor)
              .where(
                and(
                  eq(predecessor.sessionId, discordOutbox.sessionId),
                  inArray(predecessor.status, ["PENDING", "IN_FLIGHT", "FAILED"]),
                  or(
                    lt(predecessor.aggregateRevision, discordOutbox.aggregateRevision),
                    and(
                      eq(predecessor.aggregateRevision, discordOutbox.aggregateRevision),
                      lt(predecessor.ordinal, discordOutbox.ordinal)
                    )
                  )
                )
              )
          )
        )
      )
      .orderBy(
        discordOutbox.nextAttemptAt,
        discordOutbox.sessionId,
        discordOutbox.aggregateRevision,
        discordOutbox.ordinal
      )
      .limit(options.limit)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) {return [];}

    const rows = await tx
      .update(discordOutbox)
      .set({
        status: "IN_FLIGHT",
        claimExpiresAt,
        claimToken,
        attemptCount: sql`${discordOutbox.attemptCount} + 1`,
        updatedAt: options.now
      })
      .where(
        and(
          inArray(discordOutbox.id, candidates.map(({ id }) => id)),
          or(
            and(
              eq(discordOutbox.status, "PENDING"),
              lte(discordOutbox.nextAttemptAt, options.now)
            ),
            and(
              eq(discordOutbox.status, "IN_FLIGHT"),
              lte(discordOutbox.claimExpiresAt, options.now)
            )
          )
        )
      )
      .returning();
    return rows.map(mapOutboxRow).sort(
      (left, right) =>
        left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() ||
        left.sessionId.localeCompare(right.sessionId) ||
        left.aggregateRevision - right.aggregateRevision ||
        left.ordinal - right.ordinal
    );
  });
};

export const releaseExpiredOutboxClaims = async (
  db: DbLike,
  now: Date
): Promise<number> => {
  const rows = await db
    .update(discordOutbox)
    .set({
      status: "PENDING",
      claimExpiresAt: null,
      claimToken: null,
      nextAttemptAt: now,
      updatedAt: now
    })
    .where(
      and(
        eq(discordOutbox.status, "IN_FLIGHT"),
        lte(discordOutbox.claimExpiresAt, now)
      )
    )
    .returning({ id: discordOutbox.id });
  return rows.length;
};
