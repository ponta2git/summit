import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SessionRepos from "../../src/db/repositories/sessions.js";
import type { DbLike, SessionRow } from "../../src/db/repositories/sessions.js";

vi.mock("../../src/db/repositories/sessions.js", async () => {
  const actual = await vi.importActual<typeof SessionRepos>(
    "../../src/db/repositories/sessions.js"
  );
  return {
    ...actual,
    findDueAskingSessions: vi.fn(),
    findNonTerminalSessions: vi.fn(),
    findSessionById: vi.fn(),
    listResponses: vi.fn(async () => [])
  };
});

vi.mock("../../src/discord/settle.js", () => ({
  settleAskingSession: vi.fn(async () => {})
}));

const repos = await import("../../src/db/repositories/sessions.js");
const settle = await import("../../src/discord/settle.js");
const { runDeadlineTick, runStartupRecovery } = await import("../../src/scheduler/index.js");

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "session-1",
  weekKey: "2026-W17",
  postponeCount: 0,
  candidateDate: "2026-04-24",
  status: "ASKING",
  channelId: "channel",
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

const db = {} as unknown as DbLike;
const client = {} as unknown as Client;

describe("runDeadlineTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("settles each due ASKING session via settleAskingSession(deadline_unanswered) when session is still ASKING", async () => {
    const s1 = sessionRow({ id: "a" });
    const s2 = sessionRow({ id: "b" });
    vi.mocked(repos.findDueAskingSessions).mockResolvedValue([s1, s2]);
    vi.mocked(repos.findSessionById)
      .mockResolvedValueOnce(s1)
      .mockResolvedValueOnce(s2);

    await runDeadlineTick(client, db, { now: () => new Date("2026-04-24T12:31:00.000Z") });

    expect(settle.settleAskingSession).toHaveBeenCalledTimes(2);
    expect(settle.settleAskingSession).toHaveBeenNthCalledWith(1, client, db, "a", "deadline_unanswered");
    expect(settle.settleAskingSession).toHaveBeenNthCalledWith(2, client, db, "b", "deadline_unanswered");
  });

  it("swallows errors so cron keeps running", async () => {
    vi.mocked(repos.findDueAskingSessions).mockRejectedValue(new Error("boom"));
    await expect(
      runDeadlineTick(client, db, { now: () => new Date() })
    ).resolves.toBeUndefined();
  });
});

describe("runStartupRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("settles overdue ASKING sessions on startup", async () => {
    const overdue = sessionRow({ id: "overdue", deadlineAt: new Date("2026-04-24T12:30:00.000Z") });
    const notDue = sessionRow({ id: "notdue", deadlineAt: new Date("2026-04-24T12:31:00.000Z") });
    const nonAsking = sessionRow({ id: "posted", status: "POSTPONE_VOTING" });
    vi.mocked(repos.findNonTerminalSessions).mockResolvedValue([overdue, notDue, nonAsking]);
    vi.mocked(repos.findSessionById).mockResolvedValue(overdue);

    await runStartupRecovery(client, db, { now: () => new Date("2026-04-24T12:30:30.000Z") });

    expect(settle.settleAskingSession).toHaveBeenCalledTimes(1);
    expect(settle.settleAskingSession).toHaveBeenCalledWith(client, db, "overdue", "deadline_unanswered");
  });
});
