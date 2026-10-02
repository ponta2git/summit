import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetSendStateForTest,
  sendAskMessage
} from "../../../src/features/ask-session/send.js";
import {
  resetShutdownStateForTest,
  shutdownGracefully
} from "../../../src/shutdown.js";
import { memberUserId } from "../../helpers/env.js";
import { createTestAppContext } from "../../testing/index.js";

describe("sendAskMessage", () => {
  beforeEach(() => {
    resetSendStateForTest();
    resetShutdownStateForTest();
  });

  it("creates the Session and initial delivery intent atomically", async () => {
    const context = createTestAppContext({
      now: new Date("2026-04-24T18:00:00+09:00")
    });

    const result = await sendAskMessage({ trigger: "cron", context });

    expect(result.status).toBe("queued");
    expect(context.ports.sessions.listSessions()).toHaveLength(1);
    expect(context.ports.outbox.listEntries().map((entry) => ({
      dedupeKey: entry.dedupeKey,
      aggregateRevision: entry.aggregateRevision,
      ordinal: entry.ordinal
    }))).toStrictEqual([{
      dedupeKey: `ask-body-${result.sessionId}`,
      aggregateRevision: 0,
      ordinal: 0
    }]);
  });

  it("collapses concurrent cron and command requests", async () => {
    const context = createTestAppContext({
      now: new Date("2026-04-24T18:00:00+09:00")
    });

    const [first, second] = await Promise.all([
      sendAskMessage({ trigger: "cron", context }),
      sendAskMessage({
        trigger: "command",
        invokerId: memberUserId,
        context
      })
    ]);

    expect([first.status, second.status].sort()).toStrictEqual(["queued", "skipped"]);
    expect(context.ports.sessions.listSessions()).toHaveLength(1);
    expect(context.ports.outbox.listEntries()).toHaveLength(1);
  });

  it("does not create new work after shutdown starts", async () => {
    await shutdownGracefully({
      signal: "SIGTERM",
      stopScheduler: vi.fn(),
      waitForInFlightSend: async () => {},
      closeDb: async () => {},
      destroyClient: vi.fn()
    });
    const context = createTestAppContext({
      now: new Date("2026-04-24T18:00:00+09:00")
    });

    await expect(sendAskMessage({ trigger: "cron", context }))
      .rejects.toThrow("Shutdown in progress");
    expect(context.ports.sessions.listSessions()).toStrictEqual([]);
    expect(context.ports.outbox.listEntries()).toStrictEqual([]);
  });

  it("pins the in-flight key, candidate date and deadline to one clock snapshot at an ISO week boundary", async () => {
    const before = new Date("2026-04-26T23:59:59.999+09:00");
    const after = new Date("2026-04-27T00:00:00.000+09:00");
    const base = createTestAppContext({ now: before });
    const clock = { now: vi.fn().mockReturnValueOnce(before).mockReturnValue(after) };

    const result = await sendAskMessage({ trigger: "command", context: { ...base, clock } });

    expect(clock.now).toHaveBeenCalledOnce();
    expect(result.weekKey).toBe("2026-W17");
    expect(base.ports.sessions.listSessions()[0]).toMatchObject({
      weekKey: "2026-W17", candidateDateIso: "2026-04-26",
      deadlineAt: new Date("2026-04-26T21:30:00+09:00")
    });
  });

  it("never reuses an in-flight result from another AppContext", async () => {
    const first = createTestAppContext({ now: new Date("2026-04-24T18:00:00+09:00") });
    const second = createTestAppContext({ now: new Date("2026-04-24T18:00:00+09:00") });
    const results = await Promise.all([
      sendAskMessage({ trigger: "cron", context: first }),
      sendAskMessage({ trigger: "cron", context: second })
    ]);

    expect(results.map(result => result.status)).toStrictEqual(["queued", "queued"]);
    expect(first.ports.sessions.listSessions()).toHaveLength(1);
    expect(second.ports.sessions.listSessions()).toHaveLength(1);
    expect(results[0]?.sessionId).not.toBe(results[1]?.sessionId);
  });

  it("releases failed creation so a later invocation can retry", async () => {
    const context = createTestAppContext({ now: new Date("2026-04-24T18:00:00+09:00") });
    vi.spyOn(context.ports.sessions, "createAskSession").mockRejectedValueOnce(new Error("DB unavailable"));
    await expect(sendAskMessage({ trigger: "cron", context })).rejects.toThrow("DB unavailable");
    expect(await sendAskMessage({ trigger: "command", context })).toMatchObject({ status: "queued" });
    expect(context.ports.outbox.listEntries()).toHaveLength(1);
  });
});
