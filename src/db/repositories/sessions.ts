import { and, eq, inArray, lte, sql } from "drizzle-orm";

import type { db as defaultDb } from "../client.js";
import {
  RESPONSE_CHOICES,
  SESSION_STATUSES,
  type ResponseChoice,
  type SessionStatus,
  members,
  responses,
  sessions
} from "../schema.js";

export type DbLike = typeof defaultDb;

export interface SessionRow {
  id: string;
  weekKey: string;
  postponeCount: number;
  candidateDate: string;
  status: SessionStatus;
  channelId: string;
  askMessageId: string | null;
  postponeMessageId: string | null;
  deadlineAt: Date;
  decidedStartAt: Date | null;
  cancelReason: string | null;
  reminderAt: Date | null;
  reminderSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResponseRow {
  id: string;
  sessionId: string;
  memberId: string;
  choice: ResponseChoice;
  answeredAt: Date;
}

const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED"
];

const assertStatus = (value: string): SessionStatus => {
  if ((SESSION_STATUSES as readonly string[]).includes(value)) {
    return value as SessionStatus;
  }
  throw new Error(`Invalid session status: ${value}`);
};

const assertChoice = (value: string): ResponseChoice => {
  if ((RESPONSE_CHOICES as readonly string[]).includes(value)) {
    return value as ResponseChoice;
  }
  throw new Error(`Invalid response choice: ${value}`);
};

const mapSession = (row: typeof sessions.$inferSelect): SessionRow => ({
  id: row.id,
  weekKey: row.weekKey,
  postponeCount: row.postponeCount,
  candidateDate: row.candidateDate,
  status: assertStatus(row.status),
  channelId: row.channelId,
  askMessageId: row.askMessageId,
  postponeMessageId: row.postponeMessageId,
  deadlineAt: row.deadlineAt,
  decidedStartAt: row.decidedStartAt,
  cancelReason: row.cancelReason,
  reminderAt: row.reminderAt,
  reminderSentAt: row.reminderSentAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const mapResponse = (row: typeof responses.$inferSelect): ResponseRow => ({
  id: row.id,
  sessionId: row.sessionId,
  memberId: row.memberId,
  choice: assertChoice(row.choice),
  answeredAt: row.answeredAt
});

export interface CreateAskSessionInput {
  id: string;
  weekKey: string;
  postponeCount: number;
  candidateDate: string;
  channelId: string;
  deadlineAt: Date;
}

export const createAskSession = async (
  db: DbLike,
  input: CreateAskSessionInput
): Promise<SessionRow | undefined> => {
  const rows = await db
    .insert(sessions)
    .values({
      id: input.id,
      weekKey: input.weekKey,
      postponeCount: input.postponeCount,
      candidateDate: input.candidateDate,
      status: "ASKING",
      channelId: input.channelId,
      deadlineAt: input.deadlineAt
    })
    .onConflictDoNothing({
      target: [sessions.weekKey, sessions.postponeCount]
    })
    .returning();
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

export const findActiveSessionByWeekKey = async (
  db: DbLike,
  weekKey: string,
  postponeCount: number
): Promise<SessionRow | undefined> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.weekKey, weekKey),
        eq(sessions.postponeCount, postponeCount)
      )
    )
    .limit(1);
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

export const findSessionById = async (
  db: DbLike,
  id: string
): Promise<SessionRow | undefined> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

export const setAskMessageId = async (
  db: DbLike,
  id: string,
  messageId: string
): Promise<void> => {
  await db
    .update(sessions)
    .set({ askMessageId: messageId, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
};

export const setPostponeMessageId = async (
  db: DbLike,
  id: string,
  messageId: string
): Promise<void> => {
  await db
    .update(sessions)
    .set({ postponeMessageId: messageId, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
};

export interface TransitionInput {
  id: string;
  from: SessionStatus;
  to: SessionStatus;
  cancelReason?: string;
  decidedStartAt?: Date;
  reminderAt?: Date;
}

export const transitionStatus = async (
  db: DbLike,
  input: TransitionInput
): Promise<SessionRow | undefined> => {
  const patch: Record<string, unknown> = {
    status: input.to,
    updatedAt: sql`now()`
  };
  if (input.cancelReason !== undefined) {patch.cancelReason = input.cancelReason;}
  if (input.decidedStartAt !== undefined) {patch.decidedStartAt = input.decidedStartAt;}
  if (input.reminderAt !== undefined) {patch.reminderAt = input.reminderAt;}

  const rows = await db
    .update(sessions)
    .set(patch)
    .where(and(eq(sessions.id, input.id), eq(sessions.status, input.from)))
    .returning();
  const row = rows[0];
  return row ? mapSession(row) : undefined;
};

export const findDueAskingSessions = async (
  db: DbLike,
  now: Date
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.status, "ASKING"), lte(sessions.deadlineAt, now)));
  return rows.map(mapSession);
};

export const findNonTerminalSessions = async (
  db: DbLike
): Promise<SessionRow[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.status, NON_TERMINAL_STATUSES as SessionStatus[]));
  return rows.map(mapSession);
};

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

export const upsertResponse = async (
  db: DbLike,
  input: UpsertResponseInput
): Promise<ResponseRow> => {
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
): Promise<{ id: string; userId: string }[]> =>
  db.select({ id: members.id, userId: members.userId }).from(members);

export const isNonTerminal = (status: SessionStatus): boolean =>
  (NON_TERMINAL_STATUSES as readonly string[]).includes(status);
