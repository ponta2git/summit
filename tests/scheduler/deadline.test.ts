import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResponseRow, SessionRow } from "../../src/db/types.js";
import { createTestAppContext } from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

vi.mock("../../src/discord/settle.js", () => ({
  evaluateAndApplyDeadlineDecision: vi.fn(async () => {})
}));

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

const client = {} as unknown as Client;

describe("runDeadlineTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluates each due ASKING session with shared now timestamp", async () => {
    const s1 = sessionRow({
      id: "a",
      weekKey: "2026-W17",
      postponeCount: 0,
      deadlineAt: new Date("2026-04-24T12:30:00.000Z")
    });
    const s2 = sessionRow({
      id: "b",
      weekKey: "2026-W18",
      postponeCount: 0,
      deadlineAt: new Date("2026-04-24T12:30:00.000Z")
    });
    const now = new Date("2026-04-24T12:31:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [s1, s2] } });

    await runDeadlineTick(client, ctx);

    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledTimes(2);
    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenNthCalledWith(
      1,
      client,
      ctx,
      expect.objectContaining({ id: "a" }),
      [],
      { memberCountExpected: 4, now }
    );
    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenNthCalledWith(
      2,
      client,
      ctx,
      expect.objectContaining({ id: "b" }),
      [],
      { memberCountExpected: 4, now }
    );
  });

  it("passes full responses to deadline evaluator", async () => {
    const s = sessionRow({
      id: "a",
      weekKey: "2026-W17",
      postponeCount: 0,
      deadlineAt: new Date("2026-04-24T12:30:00.000Z")
    });
    const responses = [
      responseRow({ id: "r1", sessionId: "a", memberId: "m1", choice: "T2200" }),
      responseRow({ id: "r2", sessionId: "a", memberId: "m2", choice: "T2230" }),
      responseRow({ id: "r3", sessionId: "a", memberId: "m3", choice: "T2300" }),
      responseRow({ id: "r4", sessionId: "a", memberId: "m4", choice: "T2330" })
    ];
    const now = new Date("2026-04-24T12:31:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [s], responses } });

    await runDeadlineTick(client, ctx);

    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledTimes(1);
    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledWith(
      client,
      ctx,
      expect.objectContaining({ id: "a" }),
      expect.arrayContaining(responses),
      { memberCountExpected: 4, now }
    );
  });

  it("swallows errors so cron keeps running", async () => {
    const ctx = createTestAppContext();
    // race: ports の findDueAskingSessions を throw させて最外周の try/catch が握り潰すことを確認する。
    vi.spyOn(ctx.ports.sessions, "findDueAskingSessions").mockRejectedValue(new Error("boom"));
    await expect(runDeadlineTick(client, ctx)).resolves.toBeUndefined();
  });
});

describe("runStartupRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("settles overdue ASKING sessions on startup", async () => {
    const overdue = sessionRow({
      id: "overdue",
      weekKey: "2026-W17",
      postponeCount: 0,
      deadlineAt: new Date("2026-04-24T12:30:00.000Z")
    });
    const notDue = sessionRow({
      id: "notdue",
      weekKey: "2026-W18",
      postponeCount: 0,
      deadlineAt: new Date("2026-04-24T12:31:00.000Z")
    });
    const nonAsking = sessionRow({
      id: "posted",
      weekKey: "2026-W19",
      postponeCount: 0,
      status: "POSTPONE_VOTING"
    });
    const now = new Date("2026-04-24T12:30:30.000Z");
    const ctx = createTestAppContext({
      now,
      seed: { sessions: [overdue, notDue, nonAsking] }
    });

    await runStartupRecovery(client, ctx);

    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledTimes(1);
    expect(settle.evaluateAndApplyDeadlineDecision).toHaveBeenCalledWith(
      client,
      ctx,
      expect.objectContaining({ id: "overdue" }),
      [],
      { memberCountExpected: 4, now }
    );
  });
});
