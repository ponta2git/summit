import type {
  MemberRow,
  OutboxEntry,
  ResponseChoice,
  ResponseRow,
  SessionRow,
  SessionStatus
} from "../../src/db/ports.js";

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

export const makeOutboxEntry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: "outbox-1",
  kind: "send_message",
  sessionId: "session-1",
  payload: {
    kind: "send_message",
    channelId: "channel-1",
    renderer: "raw_text",
    extra: { content: "hello" }
  },
  dedupeKey: "settle-1",
  status: "FAILED",
  attemptCount: 1,
  lastError: "delivery failed",
  claimExpiresAt: null,
  nextAttemptAt: new Date("2026-04-25T12:30:00.000Z"),
  deliveredAt: null,
  deliveredMessageId: null,
  createdAt: new Date("2026-04-25T12:30:00.000Z"),
  updatedAt: new Date("2026-04-25T12:30:00.000Z"),
  ...overrides
});
