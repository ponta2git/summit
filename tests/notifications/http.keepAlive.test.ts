import { once } from "node:events";
import { Agent, request } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESULT_NOTIFICATION_BODY_TIMEOUT_MS, RESULT_NOTIFICATION_MAX_CONNECTIONS,
  RESULT_NOTIFICATION_MAX_RECEIPTS, RESULT_NOTIFICATION_MAX_REQUESTS_PER_SOCKET,
  RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "../../src/notifications/config.ts";
import { ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { createHttpHarness, operationsToken, receiverToken } from "./http.harness.ts";

describe("notification HTTP keep-alive", () => {
  let harness: Awaited<ReturnType<typeof createHttpHarness>>;
  const clients: Socket[] = [];
  const agents: Agent[] = [];
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const release of releases.splice(0)) { release(); }
    for (const client of clients.splice(0)) { client.destroy(); }
    for (const agent of agents.splice(0)) { agent.destroy(); }
    await harness?.close();
    vi.useRealTimers();
  });
  const open = async (): Promise<Socket> => {
    const accepted = once(harness.receiver.server, "connection");
    const client = connect({ host: "127.0.0.1", port: Number(new URL(harness.origin).port) });
    clients.push(client); client.on("error", () => undefined);
    await accepted; return client;
  };
  const waitForClose = (client: Socket): Promise<void> => new Promise(resolve => { client.once("close", () => resolve()); });
  const get = ["GET /internal/discord-notifications/settings/ocr_completed HTTP/1.1", "Host: localhost",
    `Authorization: Bearer ${operationsToken}`, "", ""].join("\r\n");
  const reply = (client: Socket): Promise<string> => new Promise(resolve => {
    let value = "";
    const read = (chunk: Buffer): void => {
      value += chunk.toString();
      if (value.endsWith("\r\n0\r\n\r\n")) { client.off("data", read); resolve(value); }
    };
    client.on("data", read);
  });
  const prime = async (client: Socket): Promise<void> => {
    const response = reply(client); client.write(get);
    expect(await response).toContain("HTTP/1.1 200 OK");
  };

  it("reuses successful receipt connections and closes at the finite request limit", async () => {
    harness = await createHttpHarness();
    expect(harness.receiver.server.maxConnections).toBe(RESULT_NOTIFICATION_MAX_CONNECTIONS);
    const connected = vi.fn(); harness.receiver.server.on("connection", connected);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.push(agent);
    const post = (): Promise<{ status: number; connection: string | undefined }> => new Promise((resolve, reject) => {
      const body = JSON.stringify(ocrReceiptPayload());
      const req = request(`${harness.origin}/internal/discord-notifications`, { agent, method: "POST", headers: {
        authorization: `Bearer ${receiverToken}`, "content-type": "application/json", "content-length": Buffer.byteLength(body)
      } }, res => { res.resume(); res.once("end", () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection })); });
      req.once("error", reject); req.end(body);
    });
    expect(await post()).toEqual({ status: 202, connection: "keep-alive" });
    for (let index = 1; index < RESULT_NOTIFICATION_MAX_REQUESTS_PER_SOCKET; index += 1) {
      expect(await post()).toEqual({ status: 200,
        connection: index === RESULT_NOTIFICATION_MAX_REQUESTS_PER_SOCKET - 1 ? "close" : "keep-alive" });
    }
    expect(connected).toHaveBeenCalledOnce();
    expect((await post()).status).toBe(200);
    expect(connected).toHaveBeenCalledTimes(2);
  });

  it("bounds slow headers after a successful response without extending the deadline on new bytes", async () => {
    vi.useFakeTimers(); harness = await createHttpHarness();
    const client = await open(); await prime(client);
    const closed = waitForClose(client);
    client.write("GET /internal/discord-notifications/settings/");
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS - 1);
    expect(client.destroyed).toBe(false);
    client.write("ocr_completed HTTP/1.1\r\n");
    await vi.advanceTimersByTimeAsync(1);
    await closed; expect(client.destroyed).toBe(true);
  });

  it("applies the body deadline to the second request and closes the incomplete body", async () => {
    vi.useFakeTimers(); harness = await createHttpHarness();
    const client = await open(); await prime(client);
    const entered = once(harness.receiver.server, "request");
    const response = reply(client); const closed = waitForClose(client);
    client.write(["POST /internal/discord-notifications HTTP/1.1", "Host: localhost",
      `Authorization: Bearer ${receiverToken}`, "Content-Type: application/json", "Content-Length: 100", "", "{"].join("\r\n"));
    await entered;
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_BODY_TIMEOUT_MS);
    expect(await response).toContain("HTTP/1.1 503 Service Unavailable");
    await closed; expect(harness.wake).not.toHaveBeenCalled();
  });

  it.each(["unauthorized", "unconsumed body"])("closes a reused connection with %s", async kind => {
    harness = await createHttpHarness(); const client = await open(); await prime(client);
    const response = reply(client); const closed = waitForClose(client);
    client.write(["GET /internal/discord-notifications/settings/ocr_completed HTTP/1.1", "Host: localhost",
      `Authorization: Bearer ${kind === "unauthorized" ? receiverToken : operationsToken}`,
      "Content-Length: 100", "", "{"].join("\r\n"));
    expect(await response).toContain("connection: close"); await closed;
  });

  it("closes idle reused sockets and drains reused incomplete headers immediately", async () => {
    harness = await createHttpHarness();
    // Native socket idle timers use real I/O time; shorten only this test's listener.
    harness.receiver.server.keepAliveTimeout = 20; harness.receiver.server.keepAliveTimeoutBuffer = 0;
    const idle = await open(); await prime(idle); await waitForClose(idle);
    const partial = await open(); await prime(partial); partial.write("GET /internal/");
    const closed = waitForClose(partial); harness.receiver.stop(); await harness.receiver.drain(); await closed;
    expect(harness.receiver.server.listening).toBe(false);
  });

  it("bounds pipelined incomplete headers while the previous response is still pending", async () => {
    harness = await createHttpHarness();
    const entered = deferred<void>(); const release = deferred<void>(); releases.push(() => release.resolve());
    const getSetting = harness.port.getSetting;
    harness.port.getSetting = async kind => { entered.resolve(); await release.promise; return getSetting(kind); };
    // The parser deadline is checked every second, including a partial next request
    // received before the preceding response has finished. Allow that check interval.
    harness.receiver.server.headersTimeout = 50; harness.receiver.server.requestTimeout = 50;
    const client = await open(); const closed = waitForClose(client); client.resume();
    client.write(`${get}GET /internal/discord-notifications/settings/ocr_completed HTTP/1.1\r\n`);
    await entered.promise; await closed;
    expect(client.destroyed).toBe(true); expect(harness.wake).not.toHaveBeenCalled();
  }, 2_500);

  it("preserves a pending pipelined response during shutdown after the preceding response finishes", async () => {
    harness = await createHttpHarness();
    const entered = deferred<void>(); const release = deferred<void>(); releases.push(() => release.resolve());
    const getSetting = harness.port.getSetting; let calls = 0;
    harness.port.getSetting = async kind => {
      calls += 1;
      if (calls === 2) { entered.resolve(); await release.promise; }
      return getSetting(kind);
    };
    const client = await open();
    const first = reply(client); client.write(get.repeat(2));
    await entered.promise;
    expect(await first).toContain("HTTP/1.1 200 OK");
    const second = reply(client); const closed = waitForClose(client);
    let drained = false;
    harness.receiver.stop();
    const draining = harness.receiver.drain().then(() => { drained = true; return undefined; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    // regression: the first finish must not classify this socket as idle and destroy the second response.
    const response = await Promise.race([second, closed.then(() => null)]);
    expect(response).toContain("HTTP/1.1 200 OK");
    expect(response).toContain("connection: close");
    await Promise.all([draining, closed]);
    expect(calls).toBe(2); expect(drained).toBe(true);
  });

  it("enforces the active command limit across pipelined requests on one socket", async () => {
    harness = await createHttpHarness();
    const entered = deferred<void>(); const release = deferred<void>(); releases.push(() => release.resolve());
    const getSetting = harness.port.getSetting; let calls = 0;
    harness.port.getSetting = async kind => {
      calls += 1; if (calls === RESULT_NOTIFICATION_MAX_RECEIPTS) { entered.resolve(); }
      await release.promise; return getSetting(kind);
    };
    const client = await open(); const closed = waitForClose(client); let responses = "";
    client.on("data", (chunk: Buffer) => { responses += chunk.toString(); });
    client.write(get.repeat(RESULT_NOTIFICATION_MAX_RECEIPTS + 1));
    await entered.promise; expect(calls).toBe(RESULT_NOTIFICATION_MAX_RECEIPTS);
    release.resolve(); await closed;
    expect(responses.match(/HTTP\/1.1 200 OK/g)).toHaveLength(RESULT_NOTIFICATION_MAX_RECEIPTS);
    expect(responses).toContain("HTTP/1.1 503 Service Unavailable");
    expect(calls).toBe(RESULT_NOTIFICATION_MAX_RECEIPTS);
  });
});
