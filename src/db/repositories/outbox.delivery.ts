import { and, eq, gt, inArray, or } from "drizzle-orm";

import type { DbLike } from "../rows.ts";
import { discordOutbox } from "../schema.ts";

export const markOutboxDelivered = async (
  db: DbLike,
  id: string,
  options: {
    readonly claimToken: string;
    readonly deliveredMessageId: string | null;
    readonly now: Date;
  }
): Promise<boolean> => {
  const rows = await db
    .update(discordOutbox)
    .set({
      status: "DELIVERED",
      deliveredAt: options.now,
      deliveredMessageId: options.deliveredMessageId,
      lastError: null,
      claimExpiresAt: null,
      claimToken: null,
      updatedAt: options.now
    })
    .where(
      and(
        eq(discordOutbox.id, id),
        eq(discordOutbox.status, "IN_FLIGHT"),
        eq(discordOutbox.claimToken, options.claimToken)
      )
    )
    .returning({ id: discordOutbox.id });
  return rows.length > 0;
};

/** Record retry/dead-letter only for the current claim owner. */
export const markOutboxFailed = async (
  db: DbLike,
  id: string,
  options: {
    readonly error: string;
    readonly claimToken: string;
    readonly now: Date;
    readonly nextAttemptAt: Date | null;
  }
): Promise<boolean> =>
  db.transaction(async (tx) => {
    const rows = await tx
      .update(discordOutbox)
      .set({
        status: options.nextAttemptAt === null ? "FAILED" : "PENDING",
        lastError: options.error.slice(0, 4000),
        claimExpiresAt: null,
        claimToken: null,
        nextAttemptAt: options.nextAttemptAt ?? options.now,
        updatedAt: options.now
      })
      .where(
        and(
          eq(discordOutbox.id, id),
          eq(discordOutbox.status, "IN_FLIGHT"),
          eq(discordOutbox.claimToken, options.claimToken)
        )
      )
      .returning();
    const failed = rows[0];
    if (!failed) {return false;}
    if (options.nextAttemptAt === null) {
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
            eq(discordOutbox.sessionId, failed.sessionId),
            inArray(discordOutbox.status, ["PENDING", "IN_FLIGHT"]),
            or(
              gt(discordOutbox.aggregateRevision, failed.aggregateRevision),
              and(
                eq(discordOutbox.aggregateRevision, failed.aggregateRevision),
                gt(discordOutbox.ordinal, failed.ordinal)
              )
            )
          )
        );
    }
    return true;
  });
