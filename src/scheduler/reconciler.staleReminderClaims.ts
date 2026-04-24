import type { AppContext } from "../appContext.js";
import { REMINDER_CLAIM_STALENESS_MS } from "../config.js";
import { logger } from "../logger.js";
import { subMs } from "../time/index.js";

/**
 * Invariant E: Reclaim stale reminder claims left behind by a crashed dispatch.
 *
 * @remarks
 * race: claim-first (ADR-0024) が `reminder_sent_at=now` 直後に crash すると
 * `status=DECIDED AND reminder_sent_at IS NOT NULL` で stuck する。
 * `REMINDER_CLAIM_STALENESS_MS` を超えた claim を NULL に戻し次 tick で再送させる。
 * @see ADR-0024
 */
export const reconcileStaleReminderClaims = async (
  ctx: AppContext
): Promise<number> => {
  const now = ctx.clock.now();
  const cutoff = subMs(now, REMINDER_CLAIM_STALENESS_MS);
  const stale = await ctx.ports.sessions.findStaleReminderClaims(cutoff);
  let reclaimed = 0;
  for (const session of stale) {
    if (session.reminderSentAt === null) {continue;}
    const staleSinceMs = now.getTime() - session.reminderSentAt.getTime();
    try {
      const ok = await ctx.ports.sessions.revertReminderClaim(
        session.id,
        session.reminderSentAt
      );
      if (ok) {
        reclaimed += 1;
        logger.warn(
          {
            event: "reconciler.reminder_claim_reclaimed",
            sessionId: session.id,
            weekKey: session.weekKey,
            staleSinceMs
          },
          "Reconciler: reverted stale reminder claim."
        );
      }
    } catch (error: unknown) {
      logger.error(
        {
          error,
          event: "reconciler.reminder_claim_reclaimed_failed",
          sessionId: session.id,
          weekKey: session.weekKey
        },
        "Reconciler: failed to revert stale reminder claim."
      );
    }
  }
  return reclaimed;
};
