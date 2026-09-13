import { describe, expect, it } from "vitest";

import { settlePostponeVotingSession } from "../../../src/orchestration/index.js";
import { runOutboxWorkerTick } from "../../../src/scheduler/outboxWorker.js";
import { callArg } from "../../helpers/assertions.js";
import { createTestAppContext } from "../../testing/index.js";
import {
  asMessagePayload,
  createSettleDiscordFixture,
  type MessagePayload,
  postponeResponses,
  renderedComponentData,
  seededMembers,
  sessionRow
} from "./harness.js";

const settlementAt = new Date("2026-04-24T14:00:00.000Z");
const deadlineAt = new Date("2026-04-24T15:00:00.000Z");

const votingSession = () => sessionRow({
  status: "POSTPONE_VOTING",
  postponeCount: 0,
  candidateDateIso: "2026-04-24",
  deadlineAt,
  cancelReason: null
});

const buttonsDisabled = (payload: MessagePayload): readonly boolean[] => {
  const rows = renderedComponentData(payload) as ReadonlyArray<{
    readonly components: ReadonlyArray<{ readonly disabled?: boolean }>;
  }>;
  return rows.flatMap((row) => row.components.map((button) => button.disabled === true));
};

describe("settlePostponeVotingSession", () => {
  it("creates and publishes one Saturday ASKING session when everyone votes OK", async () => {
    const session = votingSession();
    const responses = postponeResponses([
      "POSTPONE_OK",
      "POSTPONE_OK",
      "POSTPONE_OK",
      "POSTPONE_OK"
    ]);
    const ctx = createTestAppContext({
      now: settlementAt,
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const discord = createSettleDiscordFixture();

    await settlePostponeVotingSession(discord.client, ctx, session, settlementAt);

    expect(discord.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries().map((entry) => ({
      renderer: entry.payload.kind === "send_message" ? entry.payload.renderer : undefined,
      status: entry.status
    }))).toStrictEqual([{ renderer: "ask_body", status: "PENDING" }]);
    await runOutboxWorkerTick(discord.client, ctx);

    const persisted = ctx.ports.sessions.listSessions();
    expect(persisted).toHaveLength(2);
    const parent = persisted.find((candidate) => candidate.id === session.id)!;
    const saturday = persisted.find((candidate) => candidate.postponeCount === 1)!;
    expect({
      status: parent.status,
      cancelReason: parent.cancelReason,
      updatedAt: parent.updatedAt.toISOString()
    }).toStrictEqual({
      status: "POSTPONED",
      cancelReason: null,
      updatedAt: settlementAt.toISOString()
    });
    expect({
      weekKey: saturday.weekKey,
      postponeCount: saturday.postponeCount,
      candidateDateIso: saturday.candidateDateIso,
      status: saturday.status,
      channelId: saturday.channelId,
      askMessageId: saturday.askMessageId,
      postponeMessageId: saturday.postponeMessageId,
      deadlineAt: saturday.deadlineAt.toISOString()
    }).toStrictEqual({
      weekKey: session.weekKey,
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "ASKING",
      channelId: session.channelId,
      askMessageId: "posted-1",
      postponeMessageId: null,
      deadlineAt: "2026-04-25T12:30:00.000Z"
    });

    expect(discord.edit).toHaveBeenCalledTimes(1);
    const editPayload = asMessagePayload(callArg(discord.edit));
    expect(editPayload.content).toContain("明日の出欠確認へ進みます");
    expect(editPayload.content).toContain("- Member 4: 明日も募集OK");
    expect(buttonsDisabled(editPayload)).toStrictEqual([true, true]);
    expect(discord.send).toHaveBeenCalledTimes(1);
    const saturdayPost = asMessagePayload(discord.sentPayloads[0]);
    expect(saturdayPost.content).toContain("開催候補日: 2026-04-25(土) 22:00 以降");
    expect(renderedComponentData(saturdayPost)).toHaveLength(1);
    expect(ctx.ports.outbox.listEntries().map((entry) => entry.status)).toStrictEqual([
      "DELIVERED"
    ]);
  });

  it("completes with postpone_ng without creating or publishing Saturday", async () => {
    const session = votingSession();
    const responses = postponeResponses([
      "POSTPONE_OK",
      "POSTPONE_NG",
      "POSTPONE_OK",
      "POSTPONE_OK"
    ]);
    const ctx = createTestAppContext({
      now: settlementAt,
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const discord = createSettleDiscordFixture();

    await settlePostponeVotingSession(discord.client, ctx, session, settlementAt);

    expect(ctx.ports.sessions.listSessions().map((persisted) => ({
      id: persisted.id,
      status: persisted.status,
      cancelReason: persisted.cancelReason,
      updatedAt: persisted.updatedAt.toISOString()
    }))).toStrictEqual([{
      id: session.id,
      status: "COMPLETED",
      cancelReason: "postpone_ng",
      updatedAt: settlementAt.toISOString()
    }]);
    expect(discord.edit).toHaveBeenCalledTimes(1);
    const editPayload = asMessagePayload(callArg(discord.edit));
    expect(editPayload.content).toContain("- Member 2: 今週はお流れ");
    expect(editPayload.content).toContain("この回はお流れになりました");
    expect(buttonsDisabled(editPayload)).toStrictEqual([true, true]);
    expect(discord.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()).toStrictEqual([]);
  });

  it("completes with postpone_unanswered only after the deadline", async () => {
    const session = votingSession();
    const responses = postponeResponses([
      "POSTPONE_OK",
      "POSTPONE_OK",
      "POSTPONE_OK"
    ]);
    const afterDeadline = new Date("2026-04-24T15:00:01.000Z");
    const ctx = createTestAppContext({
      now: afterDeadline,
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const discord = createSettleDiscordFixture();

    await settlePostponeVotingSession(discord.client, ctx, session, afterDeadline);

    expect(ctx.ports.sessions.listSessions().map((persisted) => ({
      id: persisted.id,
      status: persisted.status,
      cancelReason: persisted.cancelReason,
      updatedAt: persisted.updatedAt.toISOString()
    }))).toStrictEqual([{
      id: session.id,
      status: "COMPLETED",
      cancelReason: "postpone_unanswered",
      updatedAt: afterDeadline.toISOString()
    }]);
    expect(discord.edit).toHaveBeenCalledTimes(1);
    const editPayload = asMessagePayload(callArg(discord.edit));
    expect(editPayload.content).toContain("- Member 4: 未回答");
    expect(editPayload.content).toContain("この回はお流れになりました");
    expect(buttonsDisabled(editPayload)).toStrictEqual([true, true]);
    expect(discord.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()).toStrictEqual([]);
  });

  it("does not duplicate the Saturday session or Discord effects on stale re-invocation", async () => {
    const session = votingSession();
    const responses = postponeResponses([
      "POSTPONE_OK",
      "POSTPONE_OK",
      "POSTPONE_OK",
      "POSTPONE_OK"
    ]);
    const ctx = createTestAppContext({
      now: settlementAt,
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const discord = createSettleDiscordFixture();

    await settlePostponeVotingSession(discord.client, ctx, session, settlementAt);
    await runOutboxWorkerTick(discord.client, ctx);
    await settlePostponeVotingSession(
      discord.client,
      ctx,
      session,
      new Date("2026-04-25T14:01:00.000Z")
    );

    expect(ctx.ports.sessions.listSessions().map((persisted) => ({
      status: persisted.status,
      postponeCount: persisted.postponeCount
    }))).toStrictEqual([
      { status: "POSTPONED", postponeCount: 0 },
      { status: "ASKING", postponeCount: 1 }
    ]);
    expect(discord.edit).toHaveBeenCalledTimes(1);
    expect(discord.send).toHaveBeenCalledTimes(1);
    expect(ctx.ports.outbox.listEntries().map((entry) => entry.status)).toStrictEqual([
      "DELIVERED"
    ]);
  });
});
