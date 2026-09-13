import { describe, expect, it } from "vitest";

import {
  evaluateAndApplyDeadlineDecision,
  settleAskingSession
} from "../../../src/orchestration/index.js";
import { runOutboxWorkerTick } from "../../../src/scheduler/outboxWorker.js";
import { appConfig } from "../../../src/userConfig.js";
import { callArg } from "../../helpers/assertions.js";
import { createTestAppContext } from "../../testing/index.js";
import {
  asMessagePayload,
  createSettleDiscordFixture,
  type MessagePayload,
  renderedComponentData,
  seededMembers,
  sessionRow
} from "./harness.js";

const now = new Date("2026-04-24T12:31:00.000Z");

const disabledStates = (payload: MessagePayload): readonly boolean[] => {
  const rows = renderedComponentData(payload) as ReadonlyArray<{
    readonly components: ReadonlyArray<{ readonly disabled?: boolean }>;
  }>;
  return rows.flatMap((row) => row.components.map((component) => component.disabled === true));
};

describe("settleAskingSession", () => {
  it("settles Friday into postpone voting and publishes the two ordered messages", async () => {
    const session = sessionRow({
      postponeCount: 0,
      status: "ASKING",
      cancelReason: null,
      postponeMessageId: null
    });
    const ctx = createTestAppContext({
      now,
      seed: { sessions: [session], members: seededMembers }
    });
    const discord = createSettleDiscordFixture();

    await settleAskingSession(discord.client, ctx, session.id, "absent");

    expect(discord.edit).toHaveBeenCalledTimes(1);
    const askEdit = asMessagePayload(callArg(discord.edit));
    expect(askEdit.content).toContain("今回はお流れです。回答は締め切りました");
    expect(disabledStates(askEdit)).toStrictEqual([true, true, true, true, true]);
    expect(discord.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries().map((entry) => ({
      renderer: entry.payload.kind === "send_message" ? entry.payload.renderer : undefined,
      ordinal: entry.ordinal,
      status: entry.status
    }))).toStrictEqual([
      { renderer: "settle_notice", ordinal: 0, status: "PENDING" },
      { renderer: "postpone_vote", ordinal: 1, status: "PENDING" }
    ]);

    await runOutboxWorkerTick(discord.client, ctx);
    await runOutboxWorkerTick(discord.client, ctx);

    expect(ctx.ports.sessions.listSessions()).toHaveLength(1);
    const persisted = ctx.ports.sessions.listSessions()[0]!;
    expect({
      id: persisted.id,
      status: persisted.status,
      cancelReason: persisted.cancelReason,
      postponeMessageId: persisted.postponeMessageId,
      deadlineAt: persisted.deadlineAt.toISOString(),
      updatedAt: persisted.updatedAt.toISOString()
    }).toStrictEqual({
      id: session.id,
      status: "POSTPONE_VOTING",
      cancelReason: "absent",
      postponeMessageId: "posted-2",
      deadlineAt: "2026-04-24T15:00:00.000Z",
      updatedAt: now.toISOString()
    });

    expect(discord.send).toHaveBeenCalledTimes(2);
    expect(discord.sentPayloads).toHaveLength(2);
    expect(discord.sentPayloads[0]).toStrictEqual({
      content: "🛑 今回は予定がそろわなかったため、お流れです。"
    });
    const postponePost = asMessagePayload(discord.sentPayloads[1]);
    expect(postponePost.content).toContain("🔁 今回はお流れです。明日も募集しますか？");
    expect(postponePost.content).toContain("回答締切: 候補日翌日 00:00 JST");
    expect(renderedComponentData(postponePost)).toHaveLength(1);
    expect(ctx.ports.outbox.listEntries().map((entry) => entry.status)).toStrictEqual([
      "DELIVERED",
      "DELIVERED"
    ]);
  });

  it("normalizes Saturday cancellation and completes the week", async () => {
    const session = sessionRow({ postponeCount: 1, status: "ASKING", cancelReason: null });
    const ctx = createTestAppContext({
      now,
      seed: { sessions: [session], members: seededMembers }
    });
    const discord = createSettleDiscordFixture();

    await settleAskingSession(discord.client, ctx, session.id, "deadline_unanswered");

    expect(discord.send).not.toHaveBeenCalled();
    await runOutboxWorkerTick(discord.client, ctx);

    expect(ctx.ports.sessions.listSessions().map((persisted) => ({
      id: persisted.id,
      status: persisted.status,
      cancelReason: persisted.cancelReason,
      updatedAt: persisted.updatedAt.toISOString()
    }))).toStrictEqual([{
      id: session.id,
      status: "COMPLETED",
      cancelReason: "saturday_cancelled",
      updatedAt: now.toISOString()
    }]);

    expect(discord.edit).toHaveBeenCalledTimes(1);
    expect(disabledStates(asMessagePayload(callArg(discord.edit)))).toStrictEqual([
      true,
      true,
      true,
      true,
      true
    ]);
    expect(discord.send).toHaveBeenCalledTimes(1);
    const mentionPrefix = appConfig.dev.suppressMentions
      ? ""
      : `${appConfig.memberUserIds.map((id) => `<@${id}>`).join(" ")}\n`;
    expect(discord.sentPayloads).toStrictEqual([{
      content: `${mentionPrefix}🛑 土曜回も予定がそろわなかったため、今週はお流れです。`
    }]);
    expect(ctx.ports.outbox.listEntries().map((entry) => entry.status)).toStrictEqual([
      "DELIVERED"
    ]);
  });

  it("keeps a Saturday decision pending until reminder delivery", async () => {
    const session = sessionRow({
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "ASKING",
      cancelReason: null
    });
    const decisionNow = new Date("2026-04-25T12:30:00.000Z");
    const responses = seededMembers.map((member, index) => ({
      id: `ask-response-${index + 1}`,
      sessionId: session.id,
      memberId: member.id,
      choice: "T2300" as const,
      answeredAt: new Date(`2026-04-25T11:${String(index).padStart(2, "0")}:00.000Z`),
      sourceInteractionId: null
    }));
    const ctx = createTestAppContext({
      now: decisionNow,
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const discord = createSettleDiscordFixture();
    await evaluateAndApplyDeadlineDecision(discord.client, ctx, session, {
      memberCountExpected: 4,
      now: decisionNow
    });

    const persisted = ctx.ports.sessions.listSessions()[0]!;
    expect({
      status: persisted.status,
      decidedStartAt: persisted.decidedStartAt?.toISOString(),
      reminderAt: persisted.reminderAt?.toISOString(),
      reminderSentAt: persisted.reminderSentAt,
      updatedAt: persisted.updatedAt.toISOString()
    }).toStrictEqual({
      status: "DECIDED",
      decidedStartAt: "2026-04-25T14:00:00.000Z",
      reminderAt: "2026-04-25T13:45:00.000Z",
      reminderSentAt: null,
      updatedAt: decisionNow.toISOString()
    });

    expect(discord.edit).toHaveBeenCalledTimes(1);
    const askEdit = asMessagePayload(callArg(discord.edit));
    expect(askEdit.content).toContain("23:00 開始で確定です");
    expect(disabledStates(askEdit)).toStrictEqual([true, true, true, true, true]);
    expect(discord.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries().map((entry) => ({
      kind: entry.kind,
      sessionId: entry.sessionId,
      dedupeKey: entry.dedupeKey,
      payload: entry.payload,
      status: entry.status,
      attemptCount: entry.attemptCount
    }))).toStrictEqual([{
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: `decided-announcement-${session.id}`,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "decided_announcement",
        extra: {}
      },
      status: "PENDING",
      attemptCount: 0
    }]);
  });

  it("is a side-effect-free no-op when the session was already settled", async () => {
    const session = sessionRow({
      status: "COMPLETED",
      cancelReason: "saturday_cancelled",
      updatedAt: now
    });
    const ctx = createTestAppContext({
      now,
      seed: { sessions: [session], members: seededMembers }
    });
    const discord = createSettleDiscordFixture();

    await settleAskingSession(discord.client, ctx, session.id, "absent");

    expect(ctx.ports.sessions.listSessions()).toStrictEqual([session]);
    expect(discord.fetch).not.toHaveBeenCalled();
    expect(discord.edit).not.toHaveBeenCalled();
    expect(discord.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()).toStrictEqual([]);
  });
});
