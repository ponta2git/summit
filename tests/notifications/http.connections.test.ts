import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "../../src/notifications/config.ts";
import { createHttpHarness, operationsToken, receiverToken } from "./http.harness.ts";

describe("notification HTTP connection ownership", () => {
  let harness: Awaited<ReturnType<typeof createHttpHarness>>;
  const clients: Socket[] = [];
  const waitForClose = (client: Socket): Promise<void> => new Promise(resolve => { client.once("close", () => resolve()); });
  afterEach(async () => {
    for (const client of clients.splice(0)) { client.destroy(); }
    await harness?.close();
    vi.useRealTimers();
  });
  const open = async (): Promise<Socket> => {
    const accepted = once(harness.receiver.server, "connection");
    const client = connect({ host: "127.0.0.1", port: Number(new URL(harness.origin).port) });
    clients.push(client);
    client.on("error", () => undefined);
    await accepted;
    return client;
  };

  it.each(["idle", "partial"])("bounds an unauthenticated %s connection from its accept time", async kind => {
    vi.useFakeTimers();
    harness = await createHttpHarness();
    const client = await open();
    const closed = waitForClose(client);
    if (kind === "partial") { client.write("POST /internal/discord-notifications HTTP/1.1\r\nHost: localhost\r\n"); }
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS);
    await closed;
    expect(client.destroyed).toBe(true);
    expect(harness.wake).not.toHaveBeenCalled();
  });

  it("drains incomplete headers immediately when stopping", async () => {
    harness = await createHttpHarness();
    const client = await open();
    client.write("POST /internal/discord-notifications HTTP/1.1\r\n");
    const closed = waitForClose(client);
    harness.receiver.stop();
    await harness.receiver.drain();
    await closed;
    expect(harness.receiver.server.listening).toBe(false);
  });

  it("rejects ambiguous authorization instead of choosing the first credential", async () => {
    harness = await createHttpHarness();
    const client = await open();
    const reply: Buffer[] = [];
    client.on("data", chunk => reply.push(chunk));
    const closed = waitForClose(client);
    client.end(["GET /internal/discord-notifications/settings/ocr_completed HTTP/1.1", "Host: localhost",
      `Authorization: Bearer ${operationsToken}`, `Authorization: Bearer ${receiverToken}`, "Connection: close", "", ""].join("\r\n"));
    await closed;
    expect(Buffer.concat(reply).toString()).toContain("HTTP/1.1 401 Unauthorized");
    expect(harness.wake).not.toHaveBeenCalled();
  });

  it.each(["http://example.test/internal/discord-notifications/settings/ocr_completed", "//example.test/internal/discord-notifications/settings/ocr_completed"])(
    "rejects a non-origin request target before dispatch", async path => {
      harness = await createHttpHarness();
      const client = await open();
      const reply: Buffer[] = [];
      client.on("data", chunk => reply.push(chunk));
      const closed = waitForClose(client);
      client.end([`GET ${path} HTTP/1.1`, "Host: localhost", `Authorization: Bearer ${operationsToken}`,
        "Connection: close", "", ""].join("\r\n"));
      await closed;
      expect(Buffer.concat(reply).toString()).toContain("HTTP/1.1 400 Bad Request");
      expect(harness.wake).not.toHaveBeenCalled();
    }
  );
});
