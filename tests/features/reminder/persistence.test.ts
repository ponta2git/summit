import { describe, expect, it } from "vitest";

import {
  sendReminderForSession,
  skipReminderAndComplete
} from "../../../src/features/reminder/send.js";
import { runOutboxWorkerTick } from "../../../src/notifications/delivery/composition.attendance.js";
import { runEffect } from "../../helpers/assertions.js";
import { createTestAppContext } from "../../testing/index.js";
import {
  createReminderDiscord,
  decidedSession,
  TEST_NOW,
  timeResponses
} from "./harness.js";

const expectedParticipants = ["member-1", "member-2", "member-3", "member-4"]
  .map((memberId) => ({
    heldEventId: "fake-held-1",
    memberId,
    createdAt: TEST_NOW
  }));

describe("HeldEvent persistence via reminder completion", () => {
  it("records the same held event when the reminder is intentionally skipped", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });

    await skipReminderAndComplete(ctx, session, TEST_NOW);

    expect(ctx.ports.heldEvents.listHeldEvents()).toStrictEqual([{
      id: "fake-held-1",
      sessionId: session.id,
      heldDateIso: "2026-04-24",
      startAt: session.decidedStartAt,
      createdAt: TEST_NOW
    }]);
    expect(ctx.ports.heldEvents.listAllParticipants()).toStrictEqual(expectedParticipants);
  });

  it("does not persist held data when Discord delivery fails", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client, send } = createReminderDiscord({ sendFails: true });

    await sendReminderForSession(client, ctx, session.id, TEST_NOW);
    await runEffect(runOutboxWorkerTick(client, ctx));

    expect(send).toHaveBeenCalledOnce();
    expect(ctx.ports.heldEvents.listHeldEvents()).toStrictEqual([]);
    expect(ctx.ports.heldEvents.listAllParticipants()).toStrictEqual([]);
    const [persisted] = ctx.ports.sessions.listSessions();
    expect({ status: persisted?.status, reminderSentAt: persisted?.reminderSentAt })
      .toStrictEqual({ status: "DECIDED", reminderSentAt: null });
  });
});
