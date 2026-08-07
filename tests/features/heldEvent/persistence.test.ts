import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRow } from "../../../src/db/rows.js";
import {
  sendReminderForSession,
  skipReminderAndComplete
} from "../../../src/features/reminder/send.js";
import { createTestAppContext } from "../../testing/index.js";
import { makeResponse } from "../../testing/fixtures.js";
import { createDiscordTextFixture } from "../../helpers/discord.js";
import { buildSessionRow } from "../../discord/factories/session.js";

const TEST_NOW = new Date("2026-04-24T12:45:00.000Z");

const decidedSession = (overrides: Partial<SessionRow> = {}): SessionRow => {
  const decidedStartAt = new Date("2026-04-24T13:00:00.000Z");
  return buildSessionRow({
    id: "session-held-1",
    askMessageId: "ask-msg-1",
    candidateDateIso: "2026-04-24",
    status: "DECIDED",
    decidedStartAt,
    reminderAt: new Date(decidedStartAt.getTime() - 15 * 60_000),
    reminderSentAt: null,
    ...overrides
  });
};

const makeReminderDiscord = (opts: { readonly sendFails?: boolean } = {}) =>
  createDiscordTextFixture(async () => {
    if (opts.sendFails === true) {
      throw new Error("send failed");
    }
    return { id: "reminder-msg-id" };
  });

const timeResponses = (sessionId: string): ReturnType<typeof makeResponse>[] => [
  makeResponse({ id: "r1", sessionId, memberId: "member-1", choice: "T2200" }),
  makeResponse({ id: "r2", sessionId, memberId: "member-2", choice: "T2230" }),
  makeResponse({ id: "r3", sessionId, memberId: "member-3", choice: "T2200" }),
  makeResponse({ id: "r4", sessionId, memberId: "member-4", choice: "T2300" })
];

describe("HeldEvent persistence via reminder completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records HeldEvent with participants when reminder is sent", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client } = makeReminderDiscord();

    await sendReminderForSession(
      client,
      ctx,
      session.id,
      TEST_NOW
    );

    const held = await ctx.ports.heldEvents.findBySessionId(session.id);
    expect(held).toStrictEqual({
      id: "fake-held-1",
      sessionId: session.id,
      heldDateIso: "2026-04-24",
      startAt: session.decidedStartAt,
      createdAt: TEST_NOW
    });
    expect(await ctx.ports.heldEvents.listParticipants("fake-held-1")).toStrictEqual(
      ["member-1", "member-2", "member-3", "member-4"].map((memberId) => ({
        heldEventId: "fake-held-1",
        memberId,
        createdAt: TEST_NOW
      }))
    );
    const completed = await ctx.ports.sessions.findSessionById(session.id);
    expect({ status: completed?.status, reminderSentAt: completed?.reminderSentAt })
      .toStrictEqual({ status: "COMPLETED", reminderSentAt: TEST_NOW });
  });

  it("records HeldEvent also when reminder is skipped (decision too close to start)", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });

    await skipReminderAndComplete(
      ctx,
      session,
      TEST_NOW
    );

    expect(await ctx.ports.heldEvents.findBySessionId(session.id)).toStrictEqual({
      id: "fake-held-1",
      sessionId: session.id,
      heldDateIso: "2026-04-24",
      startAt: session.decidedStartAt,
      createdAt: TEST_NOW
    });
    expect((await ctx.ports.heldEvents.listParticipants("fake-held-1")).map((row) => row.memberId))
      .toStrictEqual(["member-1", "member-2", "member-3", "member-4"]);
  });

  it("does NOT record HeldEvent when channel send fails (session stays DECIDED)", async () => {
    // invariant: §8.4 中止回は HeldEvent を作らない。送信失敗で DECIDED 据え置きの場合も
    //   完了 CAS に到達しないため HeldEvent は不在のまま。
    const session = decidedSession();
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client, send } = makeReminderDiscord({ sendFails: true });

    await sendReminderForSession(
      client,
      ctx,
      session.id,
      TEST_NOW
    );

    expect(send).toHaveBeenCalledOnce();
    expect(await ctx.ports.heldEvents.findBySessionId(session.id)).toBeUndefined();
    expect(ctx.ports.heldEvents.listAllParticipants()).toStrictEqual([]);
    const persisted = await ctx.ports.sessions.findSessionById(session.id);
    expect({ status: persisted?.status, reminderSentAt: persisted?.reminderSentAt })
      .toStrictEqual({ status: "DECIDED", reminderSentAt: null });
  });

  it("is idempotent when retried: second call returns undefined without duplicating HeldEvent", async () => {
    // idempotent: CAS 敗北時は held_events を書かない (tx ロールバック相当)。
    const session = decidedSession();
    const ctx = createTestAppContext({
      now: TEST_NOW,
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client, send } = makeReminderDiscord();

    await sendReminderForSession(
      client,
      ctx,
      session.id,
      TEST_NOW
    );
    // state: 2 回目は既に COMPLETED のため sendReminderForSession は早期 return する。
    await sendReminderForSession(
      client,
      ctx,
      session.id,
      new Date("2026-04-24T12:46:00.000Z")
    );

    expect(send).toHaveBeenCalledOnce();
    expect(ctx.ports.heldEvents.listHeldEvents().map((event) => event.sessionId))
      .toStrictEqual([session.id]);
  });

  it("completeDecidedSessionAsHeld returns undefined when session is not DECIDED (race lost)", async () => {
    // race: 別ハンドラが先に COMPLETED へ遷移済みのケースは fake でも undefined を返す。
    const session = decidedSession({ status: "COMPLETED" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    const result = await ctx.ports.heldEvents.completeDecidedSessionAsHeld({
      sessionId: session.id,
      reminderSentAt: new Date("2026-04-24T12:45:00.000Z"),
      memberIds: ["member-1"]
    });

    expect(result).toBeUndefined();
    expect(
      ctx.ports.heldEvents
        .listHeldEvents()
        .filter((h) => h.sessionId === session.id)
    ).toHaveLength(0);
  });
});
