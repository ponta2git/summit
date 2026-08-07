import { describe, expect, it } from "vitest";

import { runOutboxWorkerTick } from "../../src/scheduler/outboxWorker.js";
import { appConfig } from "../../src/userConfig.js";
import { createTestAppContext, makeResponse } from "../testing/index.js";
import { buildSessionRow } from "./factories/session.js";
import { stubChannel, stubClient } from "./outboxWorker.harness.js";

describe("outbox worker renderers", () => {
  it("renders a decided announcement from current persisted state", async () => {
    const session = buildSessionRow({
      id: "decided-session",
      status: "DECIDED",
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z")
    });
    const members = appConfig.memberUserIds.map((userId, index) => ({
      id: `member-${index + 1}`,
      userId,
      displayName: `Member ${index + 1}`
    }));
    const choices = ["T2200", "T2230", "T2300", "T2330"] as const;
    const responses = choices.map((choice, index) => makeResponse({
      id: `response-${index + 1}`,
      sessionId: session.id,
      memberId: members[index]!.id,
      choice
    }));
    const ctx = createTestAppContext({ seed: { sessions: [session], members, responses } });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: `decided-announcement-${session.id}`,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "decided_announcement"
      }
    });
    const { channel, sentMessages } = stubChannel();

    await runOutboxWorkerTick(stubClient(channel), ctx);

    expect(ctx.ports.outbox.listEntries()[0]?.status).toBe("DELIVERED");
    expect(sentMessages).toHaveLength(1);
    const content = sentMessages[0]?.payload.content;
    expect(content).toContain("🎉 今週の桃鉄1年勝負、開催です！");
    expect(content).toContain("開始: 23:00");
    expect(content).toContain("Member 1");
    expect(content).toContain("22:00");
  });

  it("renders a mention-suppressed cancel-week notice", async () => {
    const session = buildSessionRow({ id: "cancel-week-session" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: `cancel-week-${session.id}`,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "cancel_week_notice",
        extra: { invokerUserId: "user-1", suppressMentions: true }
      }
    });
    const { channel, sentMessages } = stubChannel();

    await runOutboxWorkerTick(stubClient(channel), ctx);

    expect(sentMessages).toStrictEqual([{
      id: "posted-1",
      payload: { content: "🛑 今週の出欠確認はお休みです（実行: user-1）" }
    }]);
    expect(ctx.ports.outbox.listEntries()[0]?.status).toBe("DELIVERED");
  });

  it("dead-letters an unsupported payload without sending", async () => {
    const session = buildSessionRow({ id: "unsupported-session" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: `unsupported-${session.id}`,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "not_registered",
        extra: {}
      }
    });
    const { channel, sentMessages } = stubChannel();

    await runOutboxWorkerTick(stubClient(channel), ctx);

    expect(sentMessages).toStrictEqual([]);
    const [entry] = ctx.ports.outbox.listEntries();
    expect({ status: entry?.status, lastError: entry?.lastError }).toStrictEqual({
      status: "FAILED",
      lastError:
        "Unsupported outbox payload: kind=send_message, renderer=not_registered"
    });
  });
});
