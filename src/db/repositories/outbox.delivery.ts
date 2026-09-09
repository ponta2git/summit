import { sql } from "drizzle-orm";
import type { DbLike } from "../rows.ts";

/** Recheck ownership and cancellation immediately before the external send. */
export const beginOutboxDelivery = async (
  db: DbLike,
  id: string,
  options: { readonly claimToken: string; readonly now: Date }
): Promise<boolean> => {
  const [row] = await db.execute<{ ok: boolean }>(sql`
    SELECT public.begin_discord_notification_part(
      ${id}, 0, ${options.claimToken}::uuid, ${options.now.toISOString()}
    ) AS ok
  `);
  return row?.ok ?? false;
};

export const markOutboxDelivered = async (
  db: DbLike,
  id: string,
  options: { readonly claimToken: string; readonly deliveredMessageId: string | null; readonly now: Date }
): Promise<boolean> => {
  const [row] = await db.execute<{ ok: boolean }>(sql`
    SELECT public.complete_discord_notification_part(
      ${id}, 0, ${options.claimToken}::uuid, ${options.deliveredMessageId}, ${options.now.toISOString()}
    ) AS ok
  `);
  return row?.ok ?? false;
};

export const markOutboxFailed = async (
  db: DbLike,
  id: string,
  options: { readonly error: string; readonly claimToken: string; readonly now: Date; readonly nextAttemptAt: Date | null }
): Promise<boolean> => {
  const [row] = await db.execute<{ ok: boolean }>(sql`
    SELECT public.fail_discord_notification(
      ${id}, ${options.claimToken}::uuid, ${options.error},
      ${options.nextAttemptAt?.toISOString() ?? null}, ${options.now.toISOString()}
    ) AS ok
  `);
  return row?.ok ?? false;
};
