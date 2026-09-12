import { request } from "node:http";
import { vi } from "vitest";
import type { ResultNotificationsPort } from "../../src/db/ports.resultNotifications.ts";
import { createNotificationReceiver } from "../../src/notifications/http.ts";
import { createFakeResultNotificationsPort } from "../testing/ports.resultNotifications.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";

export const receiverToken = "fixture-receiver-token-000000000000000000";
export const operationsToken = "fixture-operations-token-0000000000000000";
export const createHttpHarness = async (options: {
  readonly port?: ResultNotificationsPort;
  readonly canAccept?: () => boolean;
} = {}) => {
  const port = options.port ?? createFakeResultNotificationsPort({ now: () => notificationNow });
  if ("setTargetAvailable" in port && typeof port.setTargetAvailable === "function") { port.setTargetAvailable("match_draft", "draft-1", true); }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const wake = vi.fn();
  const receiver = createNotificationReceiver({ port, clock: { now: () => notificationNow }, token: receiverToken,
    operationsToken, canAccept: options.canAccept ?? (() => true), wake, logger });
  await receiver.start("127.0.0.1", 0);
  const address = receiver.server.address();
  if (!address || typeof address === "string") { throw new Error("Expected a loopback HTTP listener"); }
  const origin = `http://127.0.0.1:${address.port}`;
  return { port, wake, logger, receiver, origin, close: async () => { receiver.stop(); await receiver.drain(); } };
};

export const sendRawRequest = (origin: string, body: Buffer, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve, reject) => {
  const req = request(`${origin}/internal/discord-notifications`, { method: "POST", headers: {
    authorization: `Bearer ${receiverToken}`, "content-type": "application/json", ...headers
  } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
  req.on("error", reject); req.end(body);
});
