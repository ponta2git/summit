import type { SessionRow } from "../../../src/db/repositories/sessions.js";
import { env } from "../../../src/env.js";

// why: discord 系テスト (render / settle / dev-mention-suppression) で SessionRow を組み立てる重複を解消する。
//   scheduler 系は意図的に別 factory (tests/scheduler/factories/session.ts) を持ち、
//   シグネチャ結合を避ける (ドメイン毎に要求が分化する余地を残す)。
// @see tests/strategy review P2-b
export const buildSessionRow = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "session-default",
  weekKey: "2026-W17",
  postponeCount: 0,
  candidateDate: "2026-04-24",
  status: "ASKING",
  channelId: env.DISCORD_CHANNEL_ID,
  askMessageId: null,
  postponeMessageId: null,
  deadlineAt: new Date("2026-04-24T12:30:00.000Z"),
  decidedStartAt: null,
  cancelReason: null,
  reminderAt: null,
  reminderSentAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides
});
