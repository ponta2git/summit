import { eq } from "drizzle-orm";

import type { DbLike } from "../db/rows.js";
import { members } from "../db/schema.js";
import { logger } from "../logger.js";
import type { MemberReconcileInput } from "./inputs.js";

/**
 * Idempotently reconcile env.MEMBER_USER_IDS with the DB members table.
 *
 * @remarks
 * env に存在する userId を DB へ upsert（無ければ挿入、あれば no-op）する。
 * DELETE は行わない（ADR-0012: env から除外されたメンバーの履歴を保全するため）。
 * boot 時に cron 登録・bot login より前に呼び出し、失敗時は起動を中止する。
 * @see docs/adr/0012-member-ssot-env-db-hybrid.md
 */
// why: env を SSoT とし起動時に DB へ反映 (ADR-0012)
// idempotent: 再実行しても副作用が増えない
// invariant: members テーブル = env.MEMBER_USER_IDS の superset。display_name は DB を正本とする。
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

  // why: display_name は DB に移送 (ADR-0012)
  // invariant: env は identity (user_id), DB は付随データ (display_name)
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
    // idempotent: userId unique 制約と onConflictDoNothing で race / 再実行を吸収する。
    await db
      .insert(members)
      .values(rowsToInsert)
      .onConflictDoNothing({ target: members.userId });
  }

  logger.info(
    { inserted, existing: alreadyPresent, displayNameUpdated },
    "Members reconciled with env"
  );
};
