import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResponseRow, SessionRow } from "../../src/db/types.js";
import { createTestAppContext } from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

vi.mock("../../src/discord/settle/index.js", () => ({
  evaluateAndApplyDeadlineDecision: vi.fn(async () => {}),
  settlePostponeVotingSession: vi.fn(async () => {})
}));

const settle = await import("../../src/discord/settle/index.js");
const { runDeadlineTick, runPostponeDeadlineTick, runStartupRecovery } = await import(
  "../../src/scheduler/index.js"
);

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

  it("settles overdue POSTPONE_VOTING sessions on startup", async () => {
    const overduePostpone = sessionRow({
      id: "pv-overdue",
      weekKey: "2026-W17",
      postponeCount: 0,
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const now = new Date("2026-04-25T15:01:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [overduePostpone] } });

    await runStartupRecovery(client, ctx);

    expect(settle.settlePostponeVotingSession).toHaveBeenCalledTimes(1);
    expect(settle.settlePostponeVotingSession).toHaveBeenCalledWith(
      client,
      ctx,
      expect.objectContaining({ id: "pv-overdue" }),
      now
    );
  });

  it("leaves POSTPONE_VOTING sessions with future deadlines untouched on startup", async () => {
    const futureDeadline = sessionRow({
      id: "pv-future",
      weekKey: "2026-W17",
      postponeCount: 0,
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-26T15:00:00.000Z")
    });
    const now = new Date("2026-04-25T15:00:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [futureDeadline] } });

    await runStartupRecovery(client, ctx);

    expect(settle.settlePostponeVotingSession).not.toHaveBeenCalled();
    expect(settle.evaluateAndApplyDeadlineDecision).not.toHaveBeenCalled();
  });
});

describe("runPostponeDeadlineTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls settlePostponeVotingSession for each due POSTPONE_VOTING session", async () => {
    const s1 = sessionRow({
      id: "pv-a",
      weekKey: "2026-W17",
      postponeCount: 0,
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const s2 = sessionRow({
      id: "pv-b",
      weekKey: "2026-W18",
      postponeCount: 0,
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const now = new Date("2026-04-25T15:01:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [s1, s2] } });

    await runPostponeDeadlineTick(client, ctx);

    expect(settle.settlePostponeVotingSession).toHaveBeenCalledTimes(2);
    expect(settle.settlePostponeVotingSession).toHaveBeenNthCalledWith(
      1,
      client,
      ctx,
      expect.objectContaining({ id: "pv-a" }),
      now
    );
    expect(settle.settlePostponeVotingSession).toHaveBeenNthCalledWith(
      2,
      client,
      ctx,
      expect.objectContaining({ id: "pv-b" }),
      now
    );
  });

  it("error in one session does not prevent others from being settled", async () => {
    const s1 = sessionRow({
      id: "pv-fail",
      weekKey: "2026-W17",
      postponeCount: 0,
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const s2 = sessionRow({
      id: "pv-ok",
      weekKey: "2026-W18",
      postponeCount: 0,
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const now = new Date("2026-04-25T15:01:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [s1, s2] } });

    vi.mocked(settle.settlePostponeVotingSession)
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce(undefined);

    await expect(runPostponeDeadlineTick(client, ctx)).resolves.toBeUndefined();
    expect(settle.settlePostponeVotingSession).toHaveBeenCalledTimes(2);
  });

  it("swallows port errors so cron keeps running", async () => {
    const ctx = createTestAppContext();
    vi.spyOn(ctx.ports.sessions, "findDuePostponeVotingSessions").mockRejectedValue(
      new Error("db down")
    );

    await expect(runPostponeDeadlineTick(client, ctx)).resolves.toBeUndefined();
  });

  it("is idempotent: re-running the tick does not cause errors", async () => {
    const s = sessionRow({
      id: "pv-idem",
      weekKey: "2026-W17",
      postponeCount: 0,
      status: "POSTPONE_VOTING",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const now = new Date("2026-04-25T15:01:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [s] } });

    await runPostponeDeadlineTick(client, ctx);
    await runPostponeDeadlineTick(client, ctx);

    expect(settle.settlePostponeVotingSession).toHaveBeenCalledTimes(2);
  });
});
