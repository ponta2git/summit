import { eq } from "drizzle-orm";

import type { DbLike } from "../db/rows.js";
import { members } from "../db/schema.js";
import { logger } from "../logger.js";
import type { MemberReconcileInput } from "./inputs.js";

/**
 * Reconcile configured members into the DB members table idempotently.
 *
 * @remarks
 * user config は identity (userId) の SSoT、DB は display_name の正本。config から消えた行は DELETE しない
 * （履歴保全）。起動時に cron 登録・login より前に呼び、失敗時は起動中止。
 * @see ADR-0012
 */
export const reconcileMembers = async (
  memberInputs: ReadonlyArray<MemberReconcileInput>,
  db: DbLike
): Promise<void> => {
  const existing = await db
    .select({
      id: members.id,
      userId: members.userId,
      displayName: members.displayName
    })
    .from(members);

  const existingByUserId = new Map(existing.map((row) => [row.userId, row]));

  const inserted: string[] = [];
  const displayNameUpdated: string[] = [];
  const alreadyPresent: string[] = [];
  const rowsToInsert: { id: string; userId: string; displayName: string }[] = [];

  for (const [index, memberInput] of memberInputs.entries()) {
    const existingRow = existingByUserId.get(memberInput.userId);
    if (existingRow) {
      alreadyPresent.push(memberInput.userId);
      if (
        memberInput.syncDisplayName
        && existingRow.displayName !== memberInput.displayName
      ) {
        await db
          .update(members)
          .set({ displayName: memberInput.displayName })
          .where(eq(members.userId, memberInput.userId));
        displayNameUpdated.push(memberInput.userId);
      }
      continue;
    }

    rowsToInsert.push({
      id: `member-${index + 1}`,
      userId: memberInput.userId,
      displayName: memberInput.displayName
    });
    inserted.push(memberInput.userId);
  }

  if (rowsToInsert.length > 0) {
    // idempotent: userId unique + onConflictDoNothing で race / 再実行を吸収。
    await db
      .insert(members)
      .values(rowsToInsert)
      .onConflictDoNothing({ target: members.userId });
  }

  logger.info(
    { inserted, existing: alreadyPresent, displayNameUpdated },
    "Members reconciled with user config"
  );
};
