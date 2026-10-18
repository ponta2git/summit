// source-of-truth: Session aggregate が永続化した response の read model。
import { eq } from "drizzle-orm";

import {
  RESPONSE_CHOICES,
  responses,
  sessions
} from "../schema.ts";
import type {
  DbLike,
  ResponseRow
} from "../rows.ts";
import { assertEnum } from "../rows.ts";
import { identityLayout, nativeId } from "../identities.ts";
import { responseColumns } from "../identityColumns.ts";
export const mapResponse = (row: Omit<typeof responses.$inferSelect, "legacyId">): ResponseRow => ({
  id: row.id,
  sessionId: row.sessionId,
  memberId: row.memberId,
  choice: assertEnum(RESPONSE_CHOICES, row.choice, "response choice"),
  answeredAt: row.answeredAt,
  sourceInteractionId: row.sourceInteractionId
});

export const listResponses = async (
  db: DbLike,
  sessionId: string
): Promise<ResponseRow[]> => {
  const layout = await identityLayout(db);
  const rows = await db
    .select(responseColumns(layout))
    .from(responses)
    .where(eq(responses.sessionId, nativeId(layout, sessions, sessionId)));
  return rows.map(mapResponse);
};
