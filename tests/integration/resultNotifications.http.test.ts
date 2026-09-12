import { request } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { createHttpHarness, receiverToken } from "../notifications/http.harness.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("notification HTTP with PostgreSQL receipts", () => {
  let database: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  let http: Awaited<ReturnType<typeof createHttpHarness>>;

  beforeEach(async () => {
    database = await createResultNotificationHarness();
    http = await createHttpHarness({ port: database.port });
  });
  afterEach(async () => {
    await http?.close();
    await database?.close();
  });

  it("withholds HTTP success and wake while the real receipt transaction is blocked", async () => {
    const gate = await database.client.reserve();
    await gate`BEGIN`;
    await gate`SELECT pg_advisory_xact_lock(19790514, 1)`;
    const [owner] = await gate`SELECT pg_backend_pid() AS pid`;
    let responded = false;
    const response = fetch(`${http.origin}/internal/discord-notifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${receiverToken}`, "content-type": "application/json" },
      body: JSON.stringify(ocrReceiptPayload())
    }).then(value => { responded = true; return value; });
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const [row] = await database.client`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE ${Number(owner?.["pid"])} = ANY(pg_blocking_pids(pid))) AS blocked`;
        if (row?.["blocked"] === true) { blocked = true; break; }
        await setImmediate();
      }
      expect(blocked).toBe(true);
      expect(await database.countReceipts()).toBe(0);
      expect(responded).toBe(false);
      expect(http.wake).not.toHaveBeenCalled();
    } finally {
      await gate`COMMIT`;
      gate.release();
    }
    const accepted = await response;
    expect(accepted.status).toBe(202);
    expect(await database.port.inspect(ocrReceiptPayload().notificationId)).toMatchObject({ status: "PENDING" });
    expect(http.wake).toHaveBeenCalledExactlyOnceWith("receipt_committed");
  });

  it("retains the committed receipt after the caller loses the response, and deduplicates its next request", async () => {
    const payload = ocrReceiptPayload();
    let responseReceived = false;
    await new Promise<void>((resolve, reject) => {
      const outgoing = request(`${http.origin}/internal/discord-notifications`, {
        method: "POST",
        headers: { authorization: `Bearer ${receiverToken}`, "content-type": "application/json" }
      }, response => { responseReceived = true; response.resume(); reject(new Error("Expected a lost response")); });
      // The production route invokes wake only after the PostgreSQL command commits.
      http.wake.mockImplementationOnce(() => { outgoing.destroy(); });
      outgoing.once("error", () => resolve());
      outgoing.end(JSON.stringify(payload));
    });
    expect(responseReceived).toBe(false);
    expect(await database.countReceipts()).toBe(1);
    expect(await database.port.inspect(payload.notificationId)).toMatchObject({ status: "PENDING" });
    const duplicate = await fetch(`${http.origin}/internal/discord-notifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${receiverToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ disposition: "duplicate" });
    expect(await database.countReceipts()).toBe(1);
  });
});
