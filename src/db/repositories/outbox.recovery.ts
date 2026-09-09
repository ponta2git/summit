import { sql } from "drizzle-orm";
import type { DbLike } from "../rows.ts";

export interface RequeueFailedOutboxChainsResult {
  readonly deadLettersRequeued: number;
  readonly successorsRequeued: number;
}

/** Only attendance chains participate in this startup recovery policy. */
export const requeueFailedOutboxChains = async (
  db: DbLike, now: Date
): Promise<RequeueFailedOutboxChainsResult> => {
  const [row] = await db.execute<{ dead_letters_requeued: number; successors_requeued: number }>(sql`
    SELECT * FROM public.requeue_discord_attendance_chains(${now.toISOString()})
  `);
  return {
    deadLettersRequeued: row?.dead_letters_requeued ?? 0,
    successorsRequeued: row?.successors_requeued ?? 0
  };
};
