// source-of-truth: response 集約ルート。(sessionId, memberId) unique を前提。
import { eq } from "drizzle-orm";

import {
  RESPONSE_CHOICES,
  responses
} from "../schema.js";
import type {
  DbLike,
  ResponseChoice,
  ResponseRow
} from "../rows.js";


const assertChoice = (value: string): ResponseChoice => {
  if ((RESPONSE_CHOICES as readonly string[]).includes(value)) {
    return value as ResponseChoice;
  }
  throw new Error(`Invalid response choice: ${value}`);
};

const mapResponse = (row: typeof responses.$inferSelect): ResponseRow => ({
  id: row.id,
  sessionId: row.sessionId,
  memberId: row.memberId,
  choice: assertChoice(row.choice),
  answeredAt: row.answeredAt
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

export interface UpsertResponseInput {
  id: string;
  sessionId: string;
  memberId: string;
  choice: ResponseChoice;
  answeredAt: Date;
}

/**
 * Inserts or updates a member's response to a session (押し直し可).
 *
 * @returns The resulting response row after upsert.
 * @throws Error if the upsert returns no row (should never happen under the current schema).
 *
 * @remarks
 * `(sessionId, memberId)` unique 制約で二重投入を防ぎつつ、同一メンバーの回答変更は
 * `onConflictDoUpdate` で最新値に上書きする。
 */
export const upsertResponse = async (
  db: DbLike,
  input: UpsertResponseInput
): Promise<ResponseRow> => {
  // unique: (sessionId, memberId) unique 制約で二重投入を防ぐ。
  //   同一メンバーの回答変更 (押し直し) は onConflictDoUpdate で最新値に上書きする。
  const rows = await db
    .insert(responses)
    .values({
      id: input.id,
      sessionId: input.sessionId,
      memberId: input.memberId,
      choice: input.choice,
      answeredAt: input.answeredAt
    })
    .onConflictDoUpdate({
      target: [responses.sessionId, responses.memberId],
      set: {
        choice: input.choice,
        answeredAt: input.answeredAt
      }
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("upsertResponse returned no row");
  }
  return mapResponse(row);
};

