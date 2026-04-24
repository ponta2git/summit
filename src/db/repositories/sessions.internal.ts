// source-of-truth: sessions repository 内部 helper。barrel (sessions.ts) からは re-export しない。
// @see ADR-0038

import { and, eq, sql } from "drizzle-orm";

import {
  SESSION_STATUSES,
  discordOutbox,
  sessions
} from "../schema.js";
import type {
  DbLike,
  SessionRow,
  SessionStatus
} from "../rows.js";
import { assertEnum } from "../rows.js";
import type { AllowedNextStatus } from "../ports.js";
import type { EnqueueOutboxInput } from "./outbox.js";

export const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED"
];

export const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

export const mapSession = (row: typeof sessions.$inferSelect): SessionRow => ({
  id: row.id,
  weekKey: row.weekKey,
  postponeCount: row.postponeCount,
  candidateDateIso: row.candidateDateIso,
  status: assertEnum(SESSION_STATUSES, row.status, "session status"),
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

export const runEdgeUpdate = async <S extends SessionStatus>(
  db: DbLike,
  input: {
    readonly id: string;
    readonly from: S;
    readonly patch: {
      readonly status: AllowedNextStatus<S>;
    } & Partial<Omit<typeof sessions.$inferInsert, "status">>;
    readonly outbox: readonly EnqueueOutboxInput[] | undefined;
  }
): Promise<SessionRow | undefined> =>
  db.transaction(async (tx) => {
    const rows = await tx
      .update(sessions)
      .set(input.patch)
      .where(and(eq(sessions.id, input.id), eq(sessions.status, input.from)))
      .returning();
    const row = rows[0];
    if (!row) {return undefined;}
    // tx: CAS 成功時のみ outbox を enqueue し、状態遷移と送信 intent を atomic にする。
    //   `onConflictDoNothing(dedupeKey)` で同一 intent の再 enqueue は no-op。
    // @see docs/adr/0035-discord-send-outbox.md
    if (input.outbox && input.outbox.length > 0) {
      for (const entry of input.outbox) {
        await tx
          .insert(discordOutbox)
          .values({
            id: crypto.randomUUID(),
            kind: entry.kind,
            sessionId: entry.sessionId,
            payload: entry.payload,
            dedupeKey: entry.dedupeKey
          })
          .onConflictDoNothing({
            target: discordOutbox.dedupeKey,
            // race: partial unique index 述語と一致させる (FR second-opinion)。
            where: sql`${discordOutbox.status} IN ('PENDING','IN_FLIGHT','DELIVERED')`
          });
      }
    }
    return mapSession(row);
  });
