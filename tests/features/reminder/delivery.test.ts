import { describe, expect, it } from "vitest";

import { sendReminderForSession } from "../../../src/features/reminder/send.js";
import { runOutboxWorkerTick } from "../../../src/scheduler/outboxWorker.js";
import { REMINDER_LEAD_MINUTES } from "../../../src/config.js";
import { appConfig } from "../../../src/userConfig.js";
import { sentPayload } from "../../helpers/discord.js";
import { runEffect } from "../../helpers/assertions.js";
import { createTestAppContext } from "../../testing/index.js";
import {
  createReminderDiscord,
  decidedSession,
  TEST_NOW,
  timeResponses
} from "./harness.js";

const reminderBody = `⏰ ${REMINDER_LEAD_MINUTES}分後に開始です（22:00 開始）`;

const expectedReminderContent = (): string =>
  appConfig.dev.suppressMentions
    ? reminderBody
    : `${appConfig.memberUserIds.map((id) => `<@${id}>`).join(" ")}\n${reminderBody}`;

describe("sendReminderForSession", () => {
  it("sends the exact reminder and completes the claimed session", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client, send } = createReminderDiscord();

    await sendReminderForSession(client, ctx, session.id, TEST_NOW);
    await runEffect(runOutboxWorkerTick(client, ctx));

    expect(send).toHaveBeenCalledOnce();
    expect(sentPayload(send)).toStrictEqual({ content: expectedReminderContent() });
    const [persisted] = ctx.ports.sessions.listSessions();
    expect({
      status: persisted?.status,
      reminderSentAt: persisted?.reminderSentAt,
      updatedAt: persisted?.updatedAt
    }).toStrictEqual({
      status: "COMPLETED",
      reminderSentAt: TEST_NOW,
      updatedAt: TEST_NOW
    });
  });

  it("recovers a legacy claim marker through the outbox", async () => {
    const completedAt = new Date("2026-04-24T12:44:00.000Z");
    const session = decidedSession({ reminderSentAt: completedAt });
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client, send } = createReminderDiscord();

    await sendReminderForSession(client, ctx, session.id, TEST_NOW);

    await runEffect(runOutboxWorkerTick(client, ctx));

    expect(send).toHaveBeenCalledOnce();
    expect(ctx.ports.sessions.listSessions()[0]).toMatchObject({
      status: "COMPLETED",
      reminderSentAt: TEST_NOW
    });
    expect(ctx.ports.heldEvents.listHeldEvents()).toHaveLength(1);
  });

  it("dispatches and persists once after concurrent enqueue attempts under concurrent calls", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client, send } = createReminderDiscord();

    await Promise.all([
      sendReminderForSession(client, ctx, session.id, TEST_NOW),
      sendReminderForSession(client, ctx, session.id, TEST_NOW)
    ]);
    await runEffect(runOutboxWorkerTick(client, ctx));

    expect(send).toHaveBeenCalledOnce();
    expect(ctx.ports.sessions.listSessions().map((persisted) => ({
      id: persisted.id,
      status: persisted.status,
      reminderSentAt: persisted.reminderSentAt
    }))).toStrictEqual([{
      id: session.id,
      status: "COMPLETED",
      reminderSentAt: TEST_NOW
    }]);
    expect(ctx.ports.heldEvents.listHeldEvents().map((event) => event.sessionId))
      .toStrictEqual([session.id]);
  });

  it("omits the mention line when development suppression is enabled", async () => {
    const originalFlag = appConfig.dev.suppressMentions;
    (appConfig.dev as { suppressMentions: boolean }).suppressMentions = true;
    try {
      const session = decidedSession();
      const ctx = createTestAppContext({
        now: TEST_NOW,
        seed: { sessions: [session], responses: timeResponses(session.id) }
      });
      const { client, send } = createReminderDiscord();

      await sendReminderForSession(client, ctx, session.id, TEST_NOW);
      await runEffect(runOutboxWorkerTick(client, ctx));

      expect(sentPayload(send)).toStrictEqual({ content: reminderBody });
    } finally {
      (appConfig.dev as { suppressMentions: boolean }).suppressMentions = originalFlag;
    }
  });
});
