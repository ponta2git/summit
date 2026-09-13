import type { Client } from "discord.js";
import { okAsync } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OUTBOX_WORKER_ACTIVE_INTERVAL_MS,
  SCHEDULER_MIN_TIMER_DELAY_MS,
  SCHEDULER_WAKE_DEBOUNCE_MS
} from "../../src/config.js";
import { buildReminderIntent } from "../../src/db/repositories/sessionOutboxIntents.js";
import { createSchedulerController } from "../../src/scheduler/controller.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "../testing/sessionScenario.ts";

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

const client = {} as Client;
const okTask = () => okAsync(undefined);

describe("SchedulerController", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("debounces multiple wake requests into one scheduler hint query", async () => {
    vi.useFakeTimers();
    const ctx = createTestAppContext();
    const controller = createSchedulerController({
      client,
      context: ctx,
      logger: silentLogger,
      runDeadlineTick: vi.fn(okTask),
      runPostponeDeadlineTick: vi.fn(okTask),
      runReminderTick: vi.fn(okTask)
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
    const runDeadlineTick = vi.fn(okTask);
    const controller = createSchedulerController({
      client,
      context: ctx,
      logger: silentLogger,
      runDeadlineTick,
      runPostponeDeadlineTick: vi.fn(okTask),
      runReminderTick: vi.fn(okTask)
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
    const decidedSession = buildSessionRow({
      id: "decided",
      status: "DECIDED",
      reminderAt: now,
      reminderSentAt: null,
      decidedStartAt: new Date("2026-04-24T13:00:00.000Z")
    });
    const ctx = createTestAppContext({
      now,
      seed: { sessions: [decidedSession] }
    });
    const runReminderTick = vi.fn(() => {
      // Model the real reminder tick: enqueue succeeds, but the Session remains due
      // until the outbox worker delivers the intent.
      void ctx.ports.outbox.enqueue(buildReminderIntent(decidedSession));
      return okTask();
    });
    const controller = createSchedulerController({
      client,
      context: ctx,
      logger: silentLogger,
      runDeadlineTick: vi.fn(okTask),
      runPostponeDeadlineTick: vi.fn(okTask),
      runReminderTick
    });

    await controller.recompute("test");

    expect(runReminderTick).toHaveBeenCalledTimes(1);
    expect(silentLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduler.worker_started",
        worker: "outbox_worker"
      })
    );

    await vi.advanceTimersByTimeAsync(SCHEDULER_WAKE_DEBOUNCE_MS);
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
      dedupeKey: "settle-outbox-session",
      aggregateRevision: 0,
      ordinal: 0,
      payload: {
        kind: "send_message",
        channelId: session.channelId,
        renderer: "settle_notice",
        extra: { reason: "absent", forceSuppressMentions: true }
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
      runDeadlineTick: vi.fn(okTask),
      runPostponeDeadlineTick: vi.fn(okTask),
      runReminderTick: vi.fn(okTask)
    });

    await controller.recompute("test");
    expect(channel.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS);
    expect(channel.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(OUTBOX_WORKER_ACTIVE_INTERVAL_MS);
    expect(channel.send).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("does not start the outbox worker when no deliverable rows exist", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-24T12:00:00.000Z");
    const ctx = createTestAppContext({ now });
    const channel = { type: 0, isSendable: () => true, send: vi.fn(async () => ({ id: "m1" })) };
    const discordClient = {
      channels: { fetch: vi.fn(async () => channel) }
    } as unknown as Client;
    const controller = createSchedulerController({
      client: discordClient,
      context: ctx,
      logger: silentLogger,
      runDeadlineTick: vi.fn(okTask),
      runPostponeDeadlineTick: vi.fn(okTask),
      runReminderTick: vi.fn(okTask)
    });

    await controller.recompute("test");
    await vi.advanceTimersByTimeAsync(SCHEDULER_MIN_TIMER_DELAY_MS);

    expect(channel.send).not.toHaveBeenCalled();
    controller.stop();
  });
});
