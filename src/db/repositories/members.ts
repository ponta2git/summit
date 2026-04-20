import { eq } from "drizzle-orm";

import { members } from "../schema.js";
import type { DbLike } from "../types.js";
import type { MembersPort } from "../../ports/index.js";

export const findMemberIdByUserId = async (
  db: DbLike,
  userId: string
): Promise<string | undefined> => {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.userId, userId))
    .limit(1);
  return rows[0]?.id;
};

export const listMembers = async (
  db: DbLike
): Promise<{ id: string; userId: string; displayName: string }[]> =>
  db.select({
    id: members.id,
    userId: members.userId,
    displayName: members.displayName
  }).from(members);


// why: repository 実装が MembersPort 契約と一致することを固定する。
// invariant: listMembers は ReadonlyArray 互換の配列を返す実装契約を保つ。
const _typecheckMembersPort = {
  findMemberIdByUserId,
  listMembers
} satisfies MembersPort<DbLike>;
void _typecheckMembersPort;
