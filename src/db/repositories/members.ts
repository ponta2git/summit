import { eq } from "drizzle-orm";

import { members } from "../schema.js";
import type { DbLike } from "../rows.js";

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

