import type { SessionRow } from "../../../src/db/rows.js";
import { appConfig } from "../../../src/userConfig.js";

// why: discord 系テスト (render / settle / dev-mention-suppression) の SessionRow 組立重複を解消。scheduler 系は tests/scheduler/factories/session.ts を別建てにしてシグネチャ結合を避ける。
export const buildSessionRow = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "session-default",
  weekKey: "2026-W17",
  postponeCount: 0,
  candidateDateIso: "2026-04-24",
  status: "ASKING",
  channelId: appConfig.discord.channelId,
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
