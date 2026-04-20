import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SessionRepos from "../../src/db/repositories/sessions.js";
import type * as ResponseRepos from "../../src/db/repositories/responses.js";
import type { DbLike, ResponseRow, SessionRow } from "../../src/db/types.js";

import { buildSessionRow } from "./factories/session.js";

vi.mock("../../src/db/repositories/sessions.js", async () => {
  const actual = await vi.importActual<typeof SessionRepos>(
    "../../src/db/repositories/sessions.js"
  );
  return {
    ...actual,
    findDueAskingSessions: vi.fn(),
    findNonTerminalSessions: vi.fn()
  };
});

vi.mock("../../src/db/repositories/responses.js", async () => {
  const actual = await vi.importActual<typeof ResponseRepos>(
    "../../src/db/repositories/responses.js"
  );
  return {
    ...actual,
    listResponses: vi.fn(async () => [])
  };
});

vi.mock("../../src/discord/settle.js", () => ({
  evaluateAndApplyDeadlineDecision: vi.fn(async () => {})
}));

const repos = await import("../../src/db/repositories/sessions.js");
const responseRepos = await import("../../src/db/repositories/responses.js");
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

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({ id: "session-1", ...overrides });

const db = {} as unknown as DbLike;
const client = {} as unknown as Client;

describe("runDeadlineTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluates each due ASKING session with shared now timestamp", async () => {
    const s1 = sessionRow({ id: "a" });
    const s2 = sessionRow({ id: "b" });
    vi.mocked(repos.findDueAskingSessions).mockResolvedValue([s1, s2]);
    const now = new Date("2026-04-24T12:31:00.000Z");

    await runDeadlineTick(client, db, { now: () => now });

    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledTimes(2);
    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenNthCalledWith(
      1,
      client,
      db,
      s1,
      [],
      { memberCountExpected: 4, now }
    );
    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenNthCalledWith(
      2,
      client,
      db,
      s2,
      [],
      { memberCountExpected: 4, now }
    );
  });

  it("passes full responses to deadline evaluator", async () => {
    const s = sessionRow({ id: "a" });
    const responses = [
      responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
      responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
      responseRow({ id: "r3", memberId: "m3", choice: "T2300" }),
      responseRow({ id: "r4", memberId: "m4", choice: "T2330" })
    ];
    vi.mocked(repos.findDueAskingSessions).mockResolvedValue([s]);
    vi.mocked(responseRepos.listResponses).mockResolvedValue(responses);
    const now = new Date("2026-04-24T12:31:00.000Z");

    await runDeadlineTick(client, db, { now: () => now });

    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledTimes(1);
    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledWith(
      client,
      db,
      s,
      responses,
      { memberCountExpected: 4, now }
    );
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
    vi.mocked(responseRepos.listResponses).mockResolvedValue([]);
    const overdue = sessionRow({ id: "overdue", deadlineAt: new Date("2026-04-24T12:30:00.000Z") });
    const notDue = sessionRow({ id: "notdue", deadlineAt: new Date("2026-04-24T12:31:00.000Z") });
    const nonAsking = sessionRow({ id: "posted", status: "POSTPONE_VOTING" });
    vi.mocked(repos.findNonTerminalSessions).mockResolvedValue([overdue, notDue, nonAsking]);
    const now = new Date("2026-04-24T12:30:30.000Z");

    await runStartupRecovery(client, db, { now: () => now });

    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledTimes(1);
    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledWith(
      client,
      db,
      overdue,
      [],
      { memberCountExpected: 4, now }
    );
  });
});
