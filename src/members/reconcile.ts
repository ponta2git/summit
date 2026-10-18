import { runTransaction } from "../db/transaction.ts";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import type { DbLike } from "../db/rows.ts";
import { members } from "../db/schema.ts";
import { logger } from "../logger.ts";
import type { MemberReconcileInput } from "./inputs.ts";
import { identityLayout, wireId } from "../db/identities.ts";
import { insertIdentity } from "../db/identityInsert.ts";

interface ExistingMemberRow {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
}

interface MemberRowToInsert {
  readonly userId: string;
  readonly displayName: string;
}

interface MemberDisplayNameUpdate {
  readonly userId: string;
  readonly displayName: string;
}

interface MemberReconcilePlan {
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
    rowsToInsert: memberInputs.flatMap((memberInput) => {
      if (existingByUserId.has(memberInput.userId)) {
        return [];
      }
      return [{
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
 * user config は identity (userId) と明示された表示名の正本。config から消えた行は DELETE しない
 * （履歴保全）。起動時に cron 登録・login より前に呼び、失敗時は起動中止。
 * @see docs/architecture.md
 */
export const reconcileMembers = async (
  memberInputs: ReadonlyArray<MemberReconcileInput>,
  db: DbLike
): Promise<void> => {
  const plan = await runTransaction(db, async tx => {
    const layout = await identityLayout(tx);
    const existing = await tx
      .select({
        id: wireId(layout, members),
        userId: members.userId,
        displayName: members.displayName
      })
      .from(members);

    const changes = computeMemberReconcilePlan(memberInputs, existing);

    for (const update of changes.displayNameUpdates) {
      await tx
        .update(members)
        .set({ displayName: update.displayName })
        .where(eq(members.userId, update.userId));
    }

    if (changes.rowsToInsert.length > 0) {
      // idempotent: userId unique + onConflictDoNothing で race / 再実行を吸収。
      for (const row of changes.rowsToInsert) {
        // invariant: generate once; names/positions never identify a member.
        await insertIdentity(tx, layout, members, { id: randomUUID(), ...row },
          sql`ON CONFLICT (user_id) DO NOTHING`);
      }
    }
    return changes;
  });

  logger.info(
    {
      inserted: plan.rowsToInsert.map((row) => row.userId),
      existing: plan.alreadyPresent,
      displayNameUpdated: plan.displayNameUpdates.map((update) => update.userId)
    },
    "Members reconciled with user config"
  );
};
