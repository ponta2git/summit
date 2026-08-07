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
});
