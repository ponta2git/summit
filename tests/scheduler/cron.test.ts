import type { Client } from "discord.js";
import type { ScheduledTask } from "node-cron";
import { describe, expect, it, vi } from "vitest";

import { createAskScheduler, runReminderTick, runScheduledAskTick } from "../../src/scheduler/index.js";
import { CRON_REMINDER_SCHEDULE } from "../../src/config.js";
import { buildSessionRow } from "../discord/factories/session.js";
import { createTestAppContext } from "../testing/index.js";

describe("ask scheduler", () => {
  it("registers friday 08:00 JST ask cron as the first task with noOverlap", () => {
    const stop = vi.fn();
    const schedule = vi.fn(
      () =>
        ({
          stop
        }) as unknown as ScheduledTask
    );
    const client = {} as Client;
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const context = createTestAppContext();

    const tasks = createAskScheduler({
      client,
      context,
      sendAsk,
      cronAdapter: { schedule }
    });

    expect(tasks).toHaveLength(6);
    expect(tasks[0]?.stop).toBe(stop);
    expect(schedule).toHaveBeenNthCalledWith(1, "0 8 * * 5", expect.any(Function), {
      timezone: "Asia/Tokyo",
      noOverlap: true
    });
  });

  it("registers saturday 00:00 JST postpone-deadline cron with noOverlap", () => {
    const stop = vi.fn();
    const schedule = vi.fn(
      () =>
        ({
          stop
        }) as unknown as ScheduledTask
    );
    const client = {} as Client;
    const sendAsk = vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" }));
    const context = createTestAppContext();

    const tasks = createAskScheduler({
      client,
      context,
      sendAsk,
      cronAdapter: { schedule }
    });

    expect(tasks).toHaveLength(6);
    expect(schedule).toHaveBeenCalledWith("0 0 * * 6", expect.any(Function), {
      timezone: "Asia/Tokyo",
      noOverlap: true
    });
  });

  it("swallows cron tick errors and keeps the tick promise resolved", async () => {
    const sendAsk = vi.fn(async () => {
      throw new Error("network failure");
    });

    await expect(runScheduledAskTick(sendAsk, createTestAppContext())).resolves.toBeUndefined();
  });

  it("registers reminder cron with noOverlap on Asia/Tokyo", () => {
    const stop = vi.fn();
    const schedule = vi.fn(() => ({ stop }) as unknown as ScheduledTask);
    const tasks = createAskScheduler({
      client: {} as Client,
      context: createTestAppContext(),
      sendAsk: vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" })),
      cronAdapter: { schedule }
    });

    expect(tasks).toHaveLength(6);
    expect(schedule).toHaveBeenCalledWith(CRON_REMINDER_SCHEDULE, expect.any(Function), {
      timezone: "Asia/Tokyo",
      noOverlap: true
    });
  });

  it("dispatches reminders only for DECIDED sessions whose reminderAt has passed", async () => {
    const now = new Date("2026-04-24T12:45:00.000Z");
    const decidedStartAt = new Date("2026-04-24T13:00:00.000Z");
    const dueSession = buildSessionRow({
      id: "due-reminder",
      status: "DECIDED",
      decidedStartAt,
      reminderAt: new Date(decidedStartAt.getTime() - 15 * 60_000),
      reminderSentAt: null
    });
    const futureSession = buildSessionRow({
      id: "future-reminder",
      status: "DECIDED",
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z"),
      reminderSentAt: null
    });
    const alreadySentSession = buildSessionRow({
      id: "sent-reminder",
      status: "DECIDED",
      decidedStartAt,
      reminderAt: new Date(decidedStartAt.getTime() - 15 * 60_000),
      reminderSentAt: new Date("2026-04-24T12:45:00.000Z")
    });

    const ctx = createTestAppContext({
      seed: { sessions: [dueSession, futureSession, alreadySentSession] },
      now
    });

    const send = vi.fn(async () => ({ id: "reminder-posted" }));
    const channel = {
      type: 0,
      isSendable: () => true,
      send,
      messages: { fetch: vi.fn() }
    };
    const client = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;

    await runReminderTick(client, ctx);

    expect(send).toHaveBeenCalledTimes(1);
    const persistedDue = ctx.ports.sessions.listSessions().find((s) => s.id === dueSession.id);
    expect(persistedDue?.status).toBe("COMPLETED");
    const persistedFuture = ctx.ports.sessions
      .listSessions()
      .find((s) => s.id === futureSession.id);
    expect(persistedFuture?.status).toBe("DECIDED");
  });
});
