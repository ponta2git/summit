import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SessionRepos from "../../src/db/repositories/sessions.js";
import type { DbLike, ResponseRow, SessionRow } from "../../src/db/repositories/sessions.js";

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
  settleAskingSession: vi.fn(async () => {}),
  tryDecideIfAllTimeSlots: vi.fn(async () => true)
}));

const repos = await import("../../src/db/repositories/sessions.js");
const settle = await import("../../src/discord/settle.js");
const { runDeadlineTick, runStartupRecovery } = await import("../../src/scheduler/index.js");

const responseRow = (overrides: Partial<ResponseRow> = {}): ResponseRow => ({
  id: "r1",
  sessionId: "session-1",
  memberId: "m1",
  choice: "T2200",
  answeredAt: new Date(0),
  ...overrides
});

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

  // state: allTime 分岐 (scheduler/index.ts:90-102)。全 4 名が time choice を返したら
  //   settleAskingSession は呼ばず tryDecideIfAllTimeSlots 経由で ASKING→DECIDED を試みる。
  // invariant: decidedStartAt は最遅スロット。candidateDate=2026-04-24 + T2330 → JST 23:30 = UTC 14:30。
  it("calls tryDecideIfAllTimeSlots with latest time slot when all 4 answered with time choices", async () => {
    const s = sessionRow({ id: "a" });
    vi.mocked(repos.findDueAskingSessions).mockResolvedValue([s]);
    vi.mocked(repos.listResponses).mockResolvedValue([
      responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
      responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
      responseRow({ id: "r3", memberId: "m3", choice: "T2300" }),
      responseRow({ id: "r4", memberId: "m4", choice: "T2330" })
    ]);

    await runDeadlineTick(client, db, { now: () => new Date("2026-04-24T12:31:00.000Z") });

    expect(settle.settleAskingSession).not.toHaveBeenCalled();
    expect(settle.tryDecideIfAllTimeSlots).toHaveBeenCalledTimes(1);
    const call = vi.mocked(settle.tryDecideIfAllTimeSlots).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![1].id).toBe("a");
    expect(call![2].toISOString()).toBe("2026-04-24T14:30:00.000Z");
  });

  // state: partial 分岐 (scheduler/index.ts:104)。3/4 time choice・absent なしは deadline_unanswered。
  it("falls back to deadline_unanswered when only 3 of 4 answered without ABSENT", async () => {
    const s = sessionRow({ id: "a" });
    vi.mocked(repos.findDueAskingSessions).mockResolvedValue([s]);
    vi.mocked(repos.listResponses).mockResolvedValue([
      responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
      responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
      responseRow({ id: "r3", memberId: "m3", choice: "T2300" })
    ]);

    await runDeadlineTick(client, db, { now: () => new Date("2026-04-24T12:31:00.000Z") });

    expect(settle.tryDecideIfAllTimeSlots).not.toHaveBeenCalled();
    expect(settle.settleAskingSession).toHaveBeenCalledTimes(1);
    expect(settle.settleAskingSession).toHaveBeenCalledWith(client, db, "a", "deadline_unanswered");
  });

  // state: absent 分岐 (scheduler/index.ts:82-88)。hasAbsent 優先、choice は大文字 "ABSENT"、reason は小文字 "absent"。
  it("settles with reason=absent when any response is ABSENT (even if other 3 answered with time)", async () => {
    const s = sessionRow({ id: "a" });
    vi.mocked(repos.findDueAskingSessions).mockResolvedValue([s]);
    vi.mocked(repos.listResponses).mockResolvedValue([
      responseRow({ id: "r1", memberId: "m1", choice: "ABSENT" }),
      responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
      responseRow({ id: "r3", memberId: "m3", choice: "T2300" }),
      responseRow({ id: "r4", memberId: "m4", choice: "T2330" })
    ]);

    await runDeadlineTick(client, db, { now: () => new Date("2026-04-24T12:31:00.000Z") });

    expect(settle.tryDecideIfAllTimeSlots).not.toHaveBeenCalled();
    expect(settle.settleAskingSession).toHaveBeenCalledTimes(1);
    expect(settle.settleAskingSession).toHaveBeenCalledWith(client, db, "a", "absent");
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
    vi.mocked(repos.listResponses).mockResolvedValue([]);
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
