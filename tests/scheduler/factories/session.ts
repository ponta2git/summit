import type { SessionRow } from "../../../src/db/rows.js";
import { appConfig } from "../../../src/userConfig.js";

// why: scheduler テストは channelId を実挙動で使わない (settle* を mock するため) が、
//   factory を discord 系と共有するとシグネチャ結合で将来の drift を誘発する。
//   意図的に独立 factory を維持する。
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
