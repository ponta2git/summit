import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotificationReceiver, type NotificationReceiver } from "../../src/notifications/http.ts";
import { createFakeResultNotificationsPort } from "../testing/ports.resultNotifications.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { operationsToken, receiverToken } from "./http.harness.ts";

describe("notification receiver startup ownership", () => {
  const receivers: NotificationReceiver[] = [];
  const createReceiver = (): NotificationReceiver => {
    const clock = { now: () => notificationNow };
    const receiver = createNotificationReceiver({ clock, port: createFakeResultNotificationsPort(clock),
      token: receiverToken, operationsToken, canAccept: () => true, wake: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    receivers.push(receiver);
    return receiver;
  };
  afterEach(async () => {
    for (const receiver of receivers.splice(0)) {
      receiver.stop(); await receiver.drain();
      // Keep the test's loopback socket owned even when the shutdown regression reappears.
      if (receiver.server.listening) { await new Promise<void>(resolve => { receiver.server.close(() => resolve()); }); }
    }
  });

  it("finishes pending startup and closes its listener when stop races with listen", async () => {
    const receiver = createReceiver(); const events: string[] = [];
    const starting = receiver.start("127.0.0.1", 0).then(
      () => events.push("started"), () => events.push("failed")
    );
    receiver.stop();
    await receiver.drain();
    await setImmediate();
    expect(events).toStrictEqual(["started"]);
    expect(receiver.server.listening).toBe(false);
    await starting;
  });

  it("does not open a listener after shutdown has begun", async () => {
    const receiver = createReceiver();
    receiver.stop();
    await expect(receiver.start("127.0.0.1", 0)).rejects.toThrow("stopped");
    await receiver.drain();
    expect(receiver.server.listening).toBe(false);
  });

  it("rejects a second startup attempt while retaining the first listener's ownership", async () => {
    const receiver = createReceiver();
    const starting = receiver.start("127.0.0.1", 0);
    await expect(receiver.start("127.0.0.1", 0)).rejects.toThrow("already started");
    await starting;
    expect(receiver.server.listening).toBe(true);
    receiver.stop(); await receiver.drain();
    expect(receiver.server.listening).toBe(false);
  });
});
