import type { Client } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OUTBOX_WORKER_ACTIVE_INTERVAL_MS,
  SCHEDULER_MIN_TIMER_DELAY_MS,
  SCHEDULER_WAKE_DEBOUNCE_MS
} from "../../src/config.js";
import { createSchedulerController } from "../../src/scheduler/controller.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "../discord/factories/session.js";

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

const client = {} as Client;

describe("SchedulerController", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("debounces multiple wake requests into one scheduler hint query", async () => {
    vi.useFakeTimers();
    const ctx = createTestAppContext();
    const controller = createSchedulerController({
      client,
      context: ctx,
      logger: silentLogger,
      runDeadlineTick: vi.fn(async () => {}),
      runPostponeDeadlineTick: vi.fn(async () => {}),
      runReminderTick: vi.fn(async () => {})
    });

    controller.wake("a");
    controller.wake("b");
    await vi.advanceTimersByTimeAsync(SCHEDULER_WAKE_DEBOUNCE_MS);

    const hintCalls = ctx.ports.sessions.calls.filter((call) => call.name === "getSchedulerSessionHints");
    expect(hintCalls).toHaveLength(1);
    controller.stop();
  });

  it("schedules the nearest ASKING deadline as a one-shot timer", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-20T00:00:00.000Z");
    const deadlineAt = new Date(now.getTime() + 60_000);
    const ctx = createTestAppContext({
      now,
      seed: {
        sessions: [buildSessionRow({ id: "asking", status: "ASKING", deadlineAt })]
      }
    });
    const runDeadlineTick = vi.fn(async () => {});
    const controller = createSchedulerController({
      client,
      context: ctx,
      logger: silentLogger,
      runDeadlineTick,
      runPostponeDeadlineTick: vi.fn(async () => {}),
      runReminderTick: vi.fn(async () => {})
    });

    await controller.recompute("test");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(runDeadlineTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runDeadlineTick).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("runs due reminder work immediately during recompute", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-24T12:45:00.000Z");
    const ctx = createTestAppContext({
      now,
      seed: {
        sessions: [
          buildSessionRow({
            id: "decided",
            status: "DECIDED",
            reminderAt: now,
            reminderSentAt: null
          })
        ]
      }
    });
    const runReminderTick = vi.fn(async () => {});
    const controller = createSchedulerController({
      client,
      context: ctx,
      logger: silentLogger,
      runDeadlineTick: vi.fn(async () => {}),
      runPostponeDeadlineTick: vi.fn(async () => {}),
      runReminderTick
    });

    await controller.recompute("test");

    expect(runReminderTick).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("starts the outbox burst only while deliverable rows exist", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-24T12:00:00.000Z");
    const session = buildSessionRow({ id: "outbox-session" });
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });
    await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: session.id,
      dedupeKey: "raw-outbox-session",
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "raw_text",
        extra: { content: "hello" }
      }
    });
    const channel = { type: 0, isSendable: () => true, send: vi.fn(async () => ({ id: "m1" })) };
    const discordClient = {
      channels: { fetch: vi.fn(async () => channel) }
    } as unknown as Client;
    const controller = createSchedulerController({
      client: discordClient,
      context: ctx,
      logger: silentLogger,
      runDeadlineTick: vi.fn(async () => {}),
      runPostponeDeadlineTick: vi.fn(async () => {}),
      runReminderTick: vi.fn(async () => {})
    });

    await controller.recompute("test");
    expect(channel.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS);
    expect(channel.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(OUTBOX_WORKER_ACTIVE_INTERVAL_MS);
    expect(channel.send).toHaveBeenCalledTimes(1);
    controller.stop();
  });
});
