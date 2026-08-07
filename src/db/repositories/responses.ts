// source-of-truth: Session aggregate が永続化した response の read model。
import { eq } from "drizzle-orm";

import {
  RESPONSE_CHOICES,
  responses
} from "../schema.js";
import type {
  DbLike,
  ResponseRow
} from "../rows.js";
import { assertEnum } from "../rows.js";
export const mapResponse = (row: typeof responses.$inferSelect): ResponseRow => ({
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
  const rows = await db
    .select()
    .from(responses)
    .where(eq(responses.sessionId, sessionId));
  return rows.map(mapResponse);
};
