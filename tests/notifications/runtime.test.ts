import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResultNotificationRuntime } from "../../src/notifications/runtime.ts";
import { deferred } from "../helpers/deferred.ts";
import { createTestAppContext } from "../testing/index.ts";
import { stubClient } from "../scheduler/outboxWorker.harness.ts";

// Isolate the HTTP/dispatcher adapters; verify their owning runtime's drain and stop contract.
const adapters = vi.hoisted(() => ({
  receiver: { start: vi.fn(), stop: vi.fn(), drain: vi.fn<() => Promise<void>>() },
  dispatcher: { wake: vi.fn(), stop: vi.fn(), drain: vi.fn<() => Promise<void>>() }
}));
vi.mock("../../src/notifications/http.ts", () => ({ createNotificationReceiver: () => adapters.receiver }));
vi.mock("../../src/scheduler/resultNotifications.ts", () => ({ createResultNotificationDispatcher: () => adapters.dispatcher }));

const createRuntime = () => createResultNotificationRuntime({
  client: stubClient(undefined), context: createTestAppContext(), host: "127.0.0.1", port: 0,
  token: "test-token", operationsToken: "test-ops-token", webOrigin: "https://example.com",
  channelId: "channel-1", canAccept: () => true
});

describe("notification runtime ownership", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("waits for delivery drain after HTTP drain fails", async () => {
    const failure = new Error("receiver close failed"); const sending = deferred<void>();
    adapters.receiver.drain.mockRejectedValue(failure);
    adapters.dispatcher.drain.mockReturnValue(sending.promise);
    let drained = false;
    const outcome = createRuntime().drain().catch(error => error).finally(() => { drained = true; });
    try {
      await setImmediate();
      expect(drained).toBe(false);
    } finally { sending.resolve(); }
    expect(await outcome).toBe(failure);
  });

  it("stops delivery admission even if stopping the HTTP listener throws", () => {
    const failure = new Error("receiver stop failed");
    adapters.receiver.stop.mockImplementation(() => { throw failure; });
    expect(() => createRuntime().stop()).toThrow(failure);
    expect(adapters.dispatcher.stop).toHaveBeenCalledOnce();
  });
});
