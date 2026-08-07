// source-of-truth: sessions repository 内部 helper。barrel (sessions.ts) からは re-export しない。
// @see ADR-0051

import { SESSION_STATUSES, type sessions } from "../schema.js";
import type {
  SessionRow,
  SessionStatus
} from "../rows.js";
import { assertEnum } from "../rows.js";

export const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED"
];

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
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});
