import type { Client } from "discord.js";
import type { ScheduledTask } from "node-cron";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAskScheduler, runReminderTick, runScheduledAskTick } from "../../src/scheduler/index.js";
import { CRON_SCHEDULER_SUPERVISOR_SCHEDULE } from "../../src/config.js";
import { callArgs } from "../helpers/assertions.js";
import { buildSessionRow } from "../discord/factories/session.js";
import { createTestAppContext } from "../testing/index.js";

type ScheduleCall = readonly [
  expression: string,
  tick: () => void,
  options: { readonly timezone: string; readonly noOverlap: boolean }
];

const registeredSchedules = (schedule: ReturnType<typeof vi.fn>) =>
  schedule.mock.calls.map((_, index) => {
    const [expression, , options] = callArgs<ScheduleCall>(schedule, index);
    return { expression, options };
  });

describe("ask scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

    const scheduler = createAskScheduler({
      client,
      context,
      sendAsk,
      cronAdapter: { schedule }
    });

    expect(schedule).toHaveBeenCalledTimes(4);
    const [expression, tick, options] = callArgs<ScheduleCall>(schedule);
    expect(expression).toBe("0 8 * * 5");
    expect(tick).toBeTypeOf("function");
    expect(options).toStrictEqual({ timezone: "Asia/Tokyo", noOverlap: true });
    scheduler.stop();
    expect(stop).toHaveBeenCalledTimes(4);
  });

  it("registers scheduler supervisor cron with noOverlap", () => {
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

    const scheduler = createAskScheduler({
      client,
      context,
      sendAsk,
      cronAdapter: { schedule }
    });

    expect(schedule).toHaveBeenCalledTimes(4);
    expect(registeredSchedules(schedule)).toContainEqual({
      expression: CRON_SCHEDULER_SUPERVISOR_SCHEDULE,
      options: { timezone: "Asia/Tokyo", noOverlap: true }
    });
    scheduler.stop();
  });

  it("propagates errors to runTickSafely wrapper", async () => {
    // why: 従来は tick 内で握り潰していたが、FR-M3 で runTickSafely に隔離を移譲した。
    //   tick 関数は業務ロジックのみを実行し、例外は上位 (runTickSafely) が構造化ログ化する。
    const sendAsk = vi.fn(async () => {
      throw new Error("network failure");
    });

    await expect(runScheduledAskTick(sendAsk, createTestAppContext())).rejects.toThrow(
      "network failure"
    );
  });

  it("wraps every business-logic tick in runTickSafely (FR-M3)", async () => {
    // invariant: static cron callbacks are wrapped except healthcheck, which is internally best-effort.
    //   登録 tick 関数を実際に呼び、throw する業務ロジックを食わせて「callback が resolves する」ことで
    //   runTickSafely が挟まっていることを間接的に検証する。
    const stop = vi.fn();
    const capturedTicks: (() => void)[] = [];
    const schedule = vi.fn((_expr: string, tick: () => void) => {
      capturedTicks.push(tick);
      return { stop } as unknown as ScheduledTask;
    });
    const context = createTestAppContext();
    vi.spyOn(context.ports.sessions, "getSchedulerSessionHints").mockRejectedValue(new Error("x"));
    vi.spyOn(context.ports.outbox, "prune").mockRejectedValue(new Error("x"));
    const sendAsk = vi.fn(async () => {
      throw new Error("x");
    });

    const scheduler = createAskScheduler({ client: {} as Client, context, sendAsk, cronAdapter: { schedule } });

    const wrappedIndices = [0, 2, 3];
    for (const i of wrappedIndices) {
      const tick = capturedTicks[i];
      if (!tick) {
        throw new Error(`tick ${i} not registered`);
      }
      tick();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduler.stop();
  });

  it("does not register always-on reminder cron", () => {
    const stop = vi.fn();
    const schedule = vi.fn(() => ({ stop }) as unknown as ScheduledTask);
    const scheduler = createAskScheduler({
      client: {} as Client,
      context: createTestAppContext(),
      sendAsk: vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" })),
      cronAdapter: { schedule }
    });

    expect(registeredSchedules(schedule).map((s) => s.expression)).not.toContain("* * * * *");
    scheduler.stop();
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
