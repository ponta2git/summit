import type {
  MemberRow,
  ResponseChoice,
  ResponseRow,
  SessionRow,
  SessionStatus
} from "../../src/ports/index.js";

export const makeSession = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "session-1",
  weekKey: "2026-W17",
  postponeCount: 0,
  candidateDateIso: "2026-04-24",
  status: "ASKING" satisfies SessionStatus,
  channelId: "223456789012345678",
  askMessageId: null,
  postponeMessageId: null,
  deadlineAt: new Date("2026-04-24T12:30:00.000Z"),
  decidedStartAt: null,
  cancelReason: null,
  reminderAt: null,
  reminderSentAt: null,
  createdAt: new Date("2026-04-24T09:00:00.000Z"),
  updatedAt: new Date("2026-04-24T09:00:00.000Z"),
  ...overrides
});

export const makeMember = (overrides: Partial<MemberRow> = {}): MemberRow => ({
  id: "member-1",
  userId: "323456789012345678",
  displayName: "Member 1",
  ...overrides
});

export const makeResponse = (overrides: Partial<ResponseRow> = {}): ResponseRow => ({
  id: "response-1",
  sessionId: "session-1",
  memberId: "member-1",
  choice: "T2200" satisfies ResponseChoice,
  answeredAt: new Date("2026-04-24T12:00:00.000Z"),
  ...overrides
});
