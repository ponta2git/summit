import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRow } from "../../../src/db/rows.js";
import {
  sendReminderForSession,
  skipReminderAndComplete
} from "../../../src/features/reminder/send.js";
import { createTestAppContext } from "../../testing/index.js";
import { makeResponse } from "../../testing/fixtures.js";
import { buildSessionRow } from "../../discord/factories/session.js";

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

function makeChannel(opts: { readonly sendFails?: boolean } = {}) {
  const send = vi.fn(async (_content: unknown) => {
    if (opts.sendFails === true) {
      throw new Error("send failed");
    }
    return { id: "reminder-msg-id" };
  });
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send,
    messages: { fetch: vi.fn() }
  };
  const client = {
    channels: { fetch: vi.fn(async () => channel) }
  } as unknown as Parameters<typeof sendReminderForSession>[0];
  return { channel, client, send };
}

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
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client } = makeChannel();

    await sendReminderForSession(
      client,
      ctx,
      session.id,
      new Date("2026-04-24T12:45:00.000Z")
    );

    const held = await ctx.ports.heldEvents.findBySessionId(session.id);
    expect(held).toBeDefined();
    expect(held?.heldDateIso).toBe("2026-04-24");
    expect(held?.startAt.toISOString()).toBe(
      session.decidedStartAt?.toISOString()
    );

    const participants = await ctx.ports.heldEvents.listParticipants(
      held?.id ?? ""
    );
    expect(participants.map((p) => p.memberId).sort()).toEqual([
      "member-1",
      "member-2",
      "member-3",
      "member-4"
    ]);
  });

  it("records HeldEvent also when reminder is skipped (decision too close to start)", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });

    await skipReminderAndComplete(
      ctx,
      session,
      new Date("2026-04-24T12:55:00.000Z")
    );

    const held = await ctx.ports.heldEvents.findBySessionId(session.id);
    expect(held).toBeDefined();
    const participants = await ctx.ports.heldEvents.listParticipants(
      held?.id ?? ""
    );
    expect(participants).toHaveLength(4);
  });

  it("does NOT record HeldEvent when channel send fails (session stays DECIDED)", async () => {
    // invariant: §8.4 中止回は HeldEvent を作らない。送信失敗で DECIDED 据え置きの場合も
    //   完了 CAS に到達しないため HeldEvent は不在のまま。
    const session = decidedSession();
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client } = makeChannel({ sendFails: true });

    await sendReminderForSession(
      client,
      ctx,
      session.id,
      new Date("2026-04-24T12:45:00.000Z")
    );

    const held = await ctx.ports.heldEvents.findBySessionId(session.id);
    expect(held).toBeUndefined();
  });

  it("is idempotent when retried: second call returns undefined without duplicating HeldEvent", async () => {
    // idempotent: CAS 敗北時は held_events を書かない (tx ロールバック相当)。
    const session = decidedSession();
    const ctx = createTestAppContext({
      seed: { sessions: [session], responses: timeResponses(session.id) }
    });
    const { client } = makeChannel();

    await sendReminderForSession(
      client,
      ctx,
      session.id,
      new Date("2026-04-24T12:45:00.000Z")
    );
    // 2nd call: session は既に COMPLETED のため sendReminderForSession は早期 return する。
    await sendReminderForSession(
      client,
      ctx,
      session.id,
      new Date("2026-04-24T12:46:00.000Z")
    );

    const all = ctx.ports.heldEvents.listHeldEvents();
    expect(all.filter((h) => h.sessionId === session.id)).toHaveLength(1);
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
