import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRow } from "../../../src/db/rows.js";
import {
  sendReminderForSession,
  skipReminderAndComplete
} from "../../../src/features/reminder/send.js";
import { computeReminderAt, shouldSkipReminder } from "../../../src/features/reminder/time.js";
import { env } from "../../../src/env.js";
import { createTestAppContext } from "../../testing/index.js";
import { buildSessionRow } from "../factories/session.js";

const decidedSession = (overrides: Partial<SessionRow> = {}): SessionRow => {
  const decidedStartAt = new Date("2026-04-24T13:00:00.000Z");
  return buildSessionRow({
    id: "session-reminder-1",
    askMessageId: "ask-msg-1",
    status: "DECIDED",
    decidedStartAt,
    reminderAt: new Date(decidedStartAt.getTime() - 15 * 60_000),
    reminderSentAt: null,
    ...overrides
  });
};

function makeChannel(opts: { readonly sendFails?: boolean } = {}) {
  const send = vi.fn(async (_content: unknown) => {
    if (opts.sendFails === true) {throw new Error("send failed");}
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

describe("shouldSkipReminder", () => {
  const reminderAt = new Date("2026-04-24T12:45:00.000Z");

  it("returns false when reminderAt is more than 10 min ahead of now", () => {
    const now = new Date("2026-04-24T12:30:00.000Z");
    expect(shouldSkipReminder(now, reminderAt)).toBe(false);
  });

  it("returns false at the 10-minute boundary (>= threshold not skipped)", () => {
    const now = new Date("2026-04-24T12:35:00.000Z");
    expect(shouldSkipReminder(now, reminderAt)).toBe(false);
  });

  it("returns true when reminderAt is less than 10 min ahead", () => {
    const now = new Date("2026-04-24T12:36:00.000Z");
    expect(shouldSkipReminder(now, reminderAt)).toBe(true);
  });

  it("returns true when reminderAt is already in the past", () => {
    const now = new Date("2026-04-24T13:00:00.000Z");
    expect(shouldSkipReminder(now, reminderAt)).toBe(true);
  });
});

describe("computeReminderAt", () => {
  it("returns decidedStartAt minus 15 minutes", () => {
    const startAt = new Date("2026-04-24T13:00:00.000Z");
    expect(computeReminderAt(startAt).toISOString()).toBe("2026-04-24T12:45:00.000Z");
  });
});

describe("sendReminderForSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the reminder with mentions and transitions DECIDED to COMPLETED", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const { client, send } = makeChannel();
    const now = new Date("2026-04-24T12:45:00.000Z");

    await sendReminderForSession(client, ctx, session.id, now);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as string;
    expect(payload).toContain("15分後に開始");
    for (const userId of env.MEMBER_USER_IDS) {
      expect(payload).toContain(`<@${userId}>`);
    }

    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.reminderSentAt?.toISOString()).toBe(now.toISOString());
  });

  it("is idempotent when session is already COMPLETED", async () => {
    const session = decidedSession({
      status: "COMPLETED",
      reminderSentAt: new Date("2026-04-24T12:45:00.000Z")
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const { client, send } = makeChannel();

    await sendReminderForSession(client, ctx, session.id, new Date("2026-04-24T12:46:00.000Z"));

    expect(send).not.toHaveBeenCalled();
  });

  it("is idempotent when reminderSentAt is already set", async () => {
    const session = decidedSession({
      reminderSentAt: new Date("2026-04-24T12:45:00.000Z")
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const { client, send } = makeChannel();

    await sendReminderForSession(client, ctx, session.id, new Date("2026-04-24T12:46:00.000Z"));

    expect(send).not.toHaveBeenCalled();
  });

  it("leaves session DECIDED when the channel send fails (retryable)", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const { client, send } = makeChannel({ sendFails: true });

    await sendReminderForSession(client, ctx, session.id, new Date("2026-04-24T12:45:00.000Z"));

    expect(send).toHaveBeenCalledTimes(1);
    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    expect(persisted?.status).toBe("DECIDED");
    // regression: claim-first 導入後、送信失敗時は revert で reminderSentAt が NULL に戻ること。NULL でないと findDueReminderSessions が拾わず reminder が永久に送られない。
    expect(persisted?.reminderSentAt).toBeNull();
  });

  it("dispatches exactly once when called concurrently (claim-first prevents duplicate send)", async () => {
    // regression: cron tick と startup recovery の race で二重送信しないこと。claim-first の条件付き UPDATE が DB 層で先着 1 件だけを勝者にする (ADR-0024)。
    const session = decidedSession();
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const { client, send } = makeChannel();
    const now = new Date("2026-04-24T12:45:00.000Z");

    await Promise.all([
      sendReminderForSession(client, ctx, session.id, now),
      sendReminderForSession(client, ctx, session.id, now)
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.reminderSentAt?.toISOString()).toBe(now.toISOString());
  });

  it("omits mention line when DEV_SUPPRESS_MENTIONS is true", async () => {
    const originalFlag = env.DEV_SUPPRESS_MENTIONS;
    (env as unknown as { DEV_SUPPRESS_MENTIONS: boolean }).DEV_SUPPRESS_MENTIONS = true;
    try {
      const session = decidedSession();
      const ctx = createTestAppContext({ seed: { sessions: [session] } });
      const { client, send } = makeChannel();

      await sendReminderForSession(client, ctx, session.id, new Date("2026-04-24T12:45:00.000Z"));

      const payload = send.mock.calls[0]?.[0] as string;
      for (const userId of env.MEMBER_USER_IDS) {
        expect(payload).not.toContain(`<@${userId}>`);
      }
    } finally {
      (env as unknown as { DEV_SUPPRESS_MENTIONS: boolean }).DEV_SUPPRESS_MENTIONS = originalFlag;
    }
  });
});

describe("skipReminderAndComplete", () => {
  it("marks reminderSentAt and transitions DECIDED to COMPLETED without sending", async () => {
    const session = decidedSession();
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const now = new Date("2026-04-24T12:55:00.000Z");

    await skipReminderAndComplete(ctx, session, now);

    const persisted = ctx.ports.sessions.listSessions().find((s) => s.id === session.id);
    expect(persisted?.status).toBe("COMPLETED");
    expect(persisted?.reminderSentAt?.toISOString()).toBe(now.toISOString());
  });
});
