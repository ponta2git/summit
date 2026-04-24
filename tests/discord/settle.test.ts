import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResponseRow, SessionRow } from "../../src/db/rows.js";
import { applyDeadlineDecision, settleAskingSession, settlePostponeVotingSession } from "../../src/orchestration/index.js";
import { env } from "../../src/env.js";
import { callArg } from "../helpers/assertions.js";
import { createTestAppContext } from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({
    id: "session-1",
    askMessageId: "ask-msg-1",
    postponeMessageId: "postpone-msg-1",
    ...overrides
  });

const seededMembers = env.MEMBER_USER_IDS.map((userId, index) => ({
  id: `member-${index + 1}`,
  userId,
  displayName: `Member ${index + 1}`
}));

const postponeResponses = (choices: readonly ("POSTPONE_OK" | "POSTPONE_NG")[]): ResponseRow[] =>
  choices.map((choice, index) => ({
    id: `response-${index + 1}`,
    sessionId: "session-1",
    memberId: seededMembers[index]!.id,
    choice,
    answeredAt: new Date(`2026-04-24T11:${String(index).padStart(2, "0")}:00.000Z`)
  }));

const stubChannel = () => {
  const sentMessages: { id: string }[] = [];
  const messageEdit = vi.fn();
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: vi.fn(async (_payload: unknown) => {
      const msg = { id: `posted-${sentMessages.length + 1}` };
      sentMessages.push(msg);
      return msg;
    }),
    messages: {
      fetch: vi.fn(async () => ({ edit: messageEdit }))
    }
  };
  return { channel, sentMessages, messageEdit };
};

const stubClient = (channel: unknown): Client =>
  ({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  }) as unknown as Client;

describe("settleAskingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions ASKING → CANCELLED → POSTPONE_VOTING and posts both messages on Friday", async () => {
    const session = sessionRow({ postponeCount: 0, status: "ASKING", cancelReason: null });
    const ctx = createTestAppContext({ seed: { sessions: [session], members: seededMembers } });
    const cancelAskingSpy = vi.spyOn(ctx.ports.sessions, "cancelAsking");
    const startPostponeVotingSpy = vi.spyOn(ctx.ports.sessions, "startPostponeVoting");

    const { channel, sentMessages } = stubChannel();
    await settleAskingSession(stubClient(channel), ctx, session.id, "absent");

    expect(cancelAskingSpy).toHaveBeenCalledTimes(1);
    expect(callArg<{ reason: string }>(cancelAskingSpy).reason).toBe("absent");
    // regression: settle 通知は postpone vote と同じ直接送信経路 (FR second-opinion H1)。
    expect(callArg<unknown>(cancelAskingSpy)).not.toHaveProperty("outbox");
    expect(startPostponeVotingSpy).toHaveBeenCalledTimes(1);
    // invariant: 直接 channel.send は settle 通知 + postpone vote の 2 通。
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(sentMessages).toHaveLength(2);
    // invariant: 同期送信に戻したため outbox には settle-notice 行は enqueue されない。
    expect(ctx.ports.outbox.listEntries()).toEqual([]);
  });

  it("cancels Saturday ASKING as saturday_cancelled and completes the week", async () => {
    const session = sessionRow({ postponeCount: 1, status: "ASKING", cancelReason: null });
    const ctx = createTestAppContext({ seed: { sessions: [session], members: seededMembers } });
    const cancelAskingSpy = vi.spyOn(ctx.ports.sessions, "cancelAsking");
    const completeCancelledSpy = vi.spyOn(ctx.ports.sessions, "completeCancelledSession");
    const startPostponeVotingSpy = vi.spyOn(ctx.ports.sessions, "startPostponeVoting");

    const { channel } = stubChannel();
    await settleAskingSession(stubClient(channel), ctx, session.id, "deadline_unanswered");

    expect(cancelAskingSpy).toHaveBeenCalledTimes(1);
    expect(callArg<{ reason: string }>(cancelAskingSpy).reason).toBe("saturday_cancelled");
    expect(completeCancelledSpy).toHaveBeenCalledTimes(1);
    expect(startPostponeVotingSpy).not.toHaveBeenCalled();
    // regression: 土曜 ASKING の settle 通知も直接送信。channel.send は 1 回。
    expect(channel.send).toHaveBeenCalledTimes(1);
    // invariant: outbox には settle-notice 行は enqueue されない。
    expect(ctx.ports.outbox.listEntries()).toEqual([]);

    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    // regression: 土曜中止は CANCELLED に滞留させず COMPLETED へ収束する。
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.cancelReason).toBe("saturday_cancelled");
  });

  it("transitions Saturday ASKING to DECIDED with reminderAt and does not complete immediately", async () => {
    const session = sessionRow({ postponeCount: 1, status: "ASKING", cancelReason: null });
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-25T12:00:00.000Z")
    });
    const { channel, messageEdit } = stubChannel();

    const startAt = new Date("2026-04-25T14:00:00.000Z");
    await applyDeadlineDecision(stubClient(channel), ctx, session, {
      kind: "decided",
      chosenSlot: "T2300",
      startAt
    });

    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    // state: DECIDED のまま。COMPLETED への遷移は reminder tick で行う。
    expect(persisted?.status).toBe("DECIDED");
    expect(persisted?.decidedStartAt?.toISOString()).toBe(startAt.toISOString());
    // invariant: reminderAt = decidedStartAt - 15 分。
    expect(persisted?.reminderAt?.toISOString()).toBe(
      new Date(startAt.getTime() - 15 * 60_000).toISOString()
    );
    expect(persisted?.reminderSentAt).toBeNull();
    expect(messageEdit).toHaveBeenCalledTimes(1);
    // why: DECIDED 遷移時の開催決定メッセージは outbox へ enqueue され worker tick で配送される。直接 channel.send は ask footer 更新のみ (ADR-0035)。
    expect(channel.send).not.toHaveBeenCalled();
    const outboxEntries = ctx.ports.outbox.listEntries();
    const announce = outboxEntries.find((e) => e.dedupeKey === `decided-announcement-${session.id}`);
    expect(announce).toBeDefined();
    if (announce?.payload.kind === "send_message") {
      expect(announce.payload.renderer).toBe("decided_announcement");
    }
  });
});

describe("settlePostponeVotingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions allOk to POSTPONED and creates Saturday ASKING session", async () => {
    const session = sessionRow({
      status: "POSTPONE_VOTING",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z"),
      cancelReason: null
    });
    const responses = postponeResponses(["POSTPONE_OK", "POSTPONE_OK", "POSTPONE_OK", "POSTPONE_OK"]);
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const { channel, messageEdit } = stubChannel();

    await settlePostponeVotingSession(
      stubClient(channel),
      ctx,
      session,
      new Date("2026-04-25T14:00:00.000Z")
    );

    const persisted = ctx.ports.sessions.listSessions();
    const parent = persisted.find((s) => s.id === session.id);
    const saturday = persisted.find((s) => s.weekKey === session.weekKey && s.postponeCount === 1);
    expect(parent?.status).toBe("POSTPONED");
    expect(saturday?.status).toBe("ASKING");
    expect(saturday?.candidateDateIso).toBe("2026-04-25");
    expect(messageEdit).toHaveBeenCalledTimes(1);
    const rendered = callArg<{ content: string }>(messageEdit);
    expect(rendered.content).toContain("順延されました");
  });

  it("cancels with postpone_ng when any member selects NG", async () => {
    const session = sessionRow({
      status: "POSTPONE_VOTING",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z"),
      cancelReason: null
    });
    const responses = postponeResponses(["POSTPONE_OK", "POSTPONE_NG", "POSTPONE_OK", "POSTPONE_OK"]);
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const { channel, messageEdit } = stubChannel();

    await settlePostponeVotingSession(
      stubClient(channel),
      ctx,
      session,
      new Date("2026-04-25T14:00:00.000Z")
    );

    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    // regression: 順延 NG は COMPLETED で週を閉じる。
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.cancelReason).toBe("postpone_ng");
    expect(ctx.ports.sessions.listSessions().some((s) => s.postponeCount === 1)).toBe(false);
    expect(messageEdit).toHaveBeenCalledTimes(1);
    const rendered = callArg<{ content: string }>(messageEdit);
    expect(rendered.content).toContain("この回はお流れになりました");
  });

  it("cancels with postpone_unanswered when deadline has passed with unanswered members", async () => {
    const session = sessionRow({
      status: "POSTPONE_VOTING",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z"),
      cancelReason: null
    });
    const responses = postponeResponses(["POSTPONE_OK", "POSTPONE_OK", "POSTPONE_OK"]);
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const { channel } = stubChannel();

    await settlePostponeVotingSession(
      stubClient(channel),
      ctx,
      session,
      new Date("2026-04-25T15:00:01.000Z")
    );

    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    // regression: 順延未完も COMPLETED で週を閉じる。
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.cancelReason).toBe("postpone_unanswered");
  });

  it("is idempotent on re-invocation after already settled", async () => {
    const session = sessionRow({
      status: "POSTPONE_VOTING",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z"),
      cancelReason: null
    });
    const responses = postponeResponses(["POSTPONE_OK", "POSTPONE_OK", "POSTPONE_OK", "POSTPONE_OK"]);
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses, members: seededMembers }
    });
    const { channel } = stubChannel();
    const client = stubClient(channel);

    await settlePostponeVotingSession(client, ctx, session, new Date("2026-04-25T14:00:00.000Z"));
    await settlePostponeVotingSession(client, ctx, session, new Date("2026-04-25T14:01:00.000Z"));

    const saturdaySessions = ctx.ports.sessions
      .listSessions()
      .filter((s) => s.weekKey === session.weekKey && s.postponeCount === 1);
    expect(saturdaySessions).toHaveLength(1);
  });
});
