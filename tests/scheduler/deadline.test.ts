import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResponseRow, SessionRow } from "../../src/db/rows.js";
import { createTestAppContext } from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

import { errAsync, okAsync } from "neverthrow";

import { DiscordApiError } from "../../src/errors/index.js";
import { callArgs } from "../helpers/assertions.js";

// why: orchestration 側の Discord 副作用を停止し、スケジューラ tick が ports 経由で正しく dispatch するかだけを検証する。
vi.mock("../../src/orchestration/askDeadline.js", () => ({
  evaluateAndApplyDeadlineDecision: vi.fn(() => okAsync(undefined))
}));
vi.mock("../../src/orchestration/postponeVoting.js", () => ({
  settlePostponeVotingSession: vi.fn(() => okAsync(undefined))
}));

const askSettle = await import("../../src/orchestration/askDeadline.js");
const postponeSettle = await import("../../src/orchestration/postponeVoting.js");
// why: 旧来の `settle.foo` 参照をそのまま残すため、orchestration 2 モジュールをマージした view を作る。
const settle = { ...askSettle, ...postponeSettle };
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

type AskDeadlineCall = Parameters<typeof settle.evaluateAndApplyDeadlineDecision>;
type PostponeDeadlineCall = Parameters<typeof settle.settlePostponeVotingSession>;

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
    const firstCall = callArgs<AskDeadlineCall>(
      vi.mocked(settle.evaluateAndApplyDeadlineDecision),
      0
    );
    const secondCall = callArgs<AskDeadlineCall>(
      vi.mocked(settle.evaluateAndApplyDeadlineDecision),
      1
    );
    expect(firstCall[0]).toBe(client);
    expect(firstCall[1]).toBe(ctx);
    expect(firstCall[2].id).toBe("a");
    expect(firstCall[3]).toStrictEqual([]);
    expect(firstCall[4]).toStrictEqual({ memberCountExpected: 4, now });
    expect(secondCall[0]).toBe(client);
    expect(secondCall[1]).toBe(ctx);
    expect(secondCall[2].id).toBe("b");
    expect(secondCall[3]).toStrictEqual([]);
    expect(secondCall[4]).toStrictEqual({ memberCountExpected: 4, now });
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
    const call = callArgs<AskDeadlineCall>(vi.mocked(settle.evaluateAndApplyDeadlineDecision));
    expect(call[0]).toBe(client);
    expect(call[1]).toBe(ctx);
    expect(call[2].id).toBe("a");
    expect(call[3]).toStrictEqual(responses);
    expect(call[4]).toStrictEqual({ memberCountExpected: 4, now });
  });

  it("propagates port errors to runTickSafely wrapper", async () => {
    const ctx = createTestAppContext();
    // race: findDueAskingSessions の失敗は tick 関数が throw して返し、runTickSafely が握り潰す (FR-M3)。
    vi.spyOn(ctx.ports.sessions, "findDueAskingSessions").mockRejectedValue(new Error("boom"));
    await expect(runDeadlineTick(client, ctx)).rejects.toThrow("boom");
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
    const call = callArgs<AskDeadlineCall>(vi.mocked(settle.evaluateAndApplyDeadlineDecision));
    expect(call[0]).toBe(client);
    expect(call[1]).toBe(ctx);
    expect(call[2].id).toBe("overdue");
    expect(call[3]).toStrictEqual([]);
    expect(call[4]).toStrictEqual({ memberCountExpected: 4, now });
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
    const call = callArgs<PostponeDeadlineCall>(vi.mocked(settle.settlePostponeVotingSession));
    expect(call[0]).toBe(client);
    expect(call[1]).toBe(ctx);
    expect(call[2].id).toBe("pv-overdue");
    expect(call[3]).toBe(now);
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
    const firstCall = callArgs<PostponeDeadlineCall>(
      vi.mocked(settle.settlePostponeVotingSession),
      0
    );
    const secondCall = callArgs<PostponeDeadlineCall>(
      vi.mocked(settle.settlePostponeVotingSession),
      1
    );
    expect(firstCall[0]).toBe(client);
    expect(firstCall[1]).toBe(ctx);
    expect(firstCall[2].id).toBe("pv-a");
    expect(firstCall[3]).toBe(now);
    expect(secondCall[0]).toBe(client);
    expect(secondCall[1]).toBe(ctx);
    expect(secondCall[2].id).toBe("pv-b");
    expect(secondCall[3]).toBe(now);
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
      .mockReturnValueOnce(errAsync(new DiscordApiError("network failure")))
      .mockReturnValueOnce(okAsync(undefined));

    await expect(runPostponeDeadlineTick(client, ctx)).resolves.toBeUndefined();
    expect(settle.settlePostponeVotingSession).toHaveBeenCalledTimes(2);
  });

  it("propagates port errors to runTickSafely wrapper", async () => {
    const ctx = createTestAppContext();
    vi.spyOn(ctx.ports.sessions, "findDuePostponeVotingSessions").mockRejectedValue(
      new Error("db down")
    );

    await expect(runPostponeDeadlineTick(client, ctx)).rejects.toThrow("db down");
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
