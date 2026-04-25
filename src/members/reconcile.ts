import { eq } from "drizzle-orm";

import type { DbLike } from "../db/rows.js";
import { members } from "../db/schema.js";
import { logger } from "../logger.js";
import type { MemberReconcileInput } from "./inputs.js";

interface ExistingMemberRow {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
}

interface MemberRowToInsert {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
}

interface MemberDisplayNameUpdate {
  readonly userId: string;
  readonly displayName: string;
}

export interface MemberReconcilePlan {
  readonly rowsToInsert: readonly MemberRowToInsert[];
  readonly displayNameUpdates: readonly MemberDisplayNameUpdate[];
  readonly alreadyPresent: readonly string[];
}

export const computeMemberReconcilePlan = (
  memberInputs: ReadonlyArray<MemberReconcileInput>,
  existing: readonly ExistingMemberRow[]
): MemberReconcilePlan => {
  const existingByUserId = new Map(existing.map((row) => [row.userId, row]));

  return {
    rowsToInsert: memberInputs.flatMap((memberInput, index) => {
      if (existingByUserId.has(memberInput.userId)) {
        return [];
      }
      return [{
        id: `member-${index + 1}`,
        userId: memberInput.userId,
        displayName: memberInput.displayName
      }];
    }),
    displayNameUpdates: memberInputs.flatMap((memberInput) => {
      const existingRow = existingByUserId.get(memberInput.userId);
      if (
        existingRow === undefined
        || !memberInput.syncDisplayName
        || existingRow.displayName === memberInput.displayName
      ) {
        return [];
      }
      return [{ userId: memberInput.userId, displayName: memberInput.displayName }];
    }),
    alreadyPresent: memberInputs.flatMap((memberInput) =>
      existingByUserId.has(memberInput.userId) ? [memberInput.userId] : []
    )
  };
};

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

  const plan = computeMemberReconcilePlan(memberInputs, existing);

  for (const update of plan.displayNameUpdates) {
    await db
      .update(members)
      .set({ displayName: update.displayName })
      .where(eq(members.userId, update.userId));
  }

  if (plan.rowsToInsert.length > 0) {
    // idempotent: userId unique + onConflictDoNothing で race / 再実行を吸収。
    await db
      .insert(members)
      .values([...plan.rowsToInsert])
      .onConflictDoNothing({ target: members.userId });
  }

  logger.info(
    {
      inserted: plan.rowsToInsert.map((row) => row.userId),
      existing: plan.alreadyPresent,
      displayNameUpdated: plan.displayNameUpdates.map((update) => update.userId)
    },
    "Members reconciled with user config"
  );
};
