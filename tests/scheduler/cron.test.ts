import type { Client } from "discord.js";
import type { ScheduledTask } from "node-cron";
import { describe, expect, it, vi } from "vitest";

import { createAskScheduler, runScheduledAskTick } from "../../src/scheduler/index.js";
import { createTestAppContext } from "../testing/index.js";

describe("ask scheduler", () => {
  it("registers friday 08:00 JST cron with noOverlap", () => {
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

    const handles = createAskScheduler({
      client,
      context,
      sendAsk,
      cronAdapter: { schedule }
    });

    expect(handles.askTask.stop).toBe(stop);
    expect(schedule).toHaveBeenCalledWith("0 8 * * 5", expect.any(Function), {
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
});
