import { setImmediate } from "node:timers/promises";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMaintenanceDrain, type MaintenanceDrain } from "../../src/startup/maintenanceDrain.ts";
import { createFakeResultNotificationsPort } from "../testing/ports.resultNotifications.ts";
import { notificationNow, ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { createHttpHarness, operationsToken, receiverToken } from "./http.harness.ts";

const path = "/internal/maintenance/drain";
const cutover = { cutoverId: "cutover-20261018", stopEpoch: 1 };
const headers = { authorization: `Bearer ${operationsToken}`, "content-type": "application/json" };
describe("authenticated live maintenance control", () => {
  let harness: Awaited<ReturnType<typeof createHttpHarness>>;
  afterEach(async () => { await harness?.close(); });
  const control = (body: unknown, token = operationsToken) => fetch(`${harness.origin}${path}`, {
    method: "POST", headers: { ...headers, authorization: `Bearer ${token}` }, body: JSON.stringify(body)
  });

  it("authenticates before state change and keeps status available while business readiness is false", async () => {
    const stop = vi.fn(); const maintenance = createMaintenanceDrain([{ name: "test", stage: "admission", stop, drain: () => undefined }]);
    harness = await createHttpHarness({ maintenance, canAccept: () => false });
    expect((await control({ ...cutover, stage: "admission" }, receiverToken)).status).toBe(401);
    expect(stop).not.toHaveBeenCalled();
    const response = await control({ ...cutover, stage: "admission" });
    expect(response.status).toBe(202); await response.json(); await setImmediate();
    const state = await fetch(`${harness.origin}${path}`, { headers });
    expect(state.status).toBe(200); expect(await state.json()).toMatchObject({ ...cutover, stage: "admission", phase: "drained" });
    expect((await fetch(`${harness.origin}${path}`)).status).toBe(401);
  });

  it("bounds and validates IDs, epochs and stages before stopping; rejects cutover mixing and reversal", async () => {
    const maintenance = createMaintenanceDrain([]); harness = await createHttpHarness({ maintenance });
    for (const body of [{ ...cutover, stage: "bad" }, { ...cutover, stage: "all", extra: true },
      { ...cutover, stage: "all", stopEpoch: "1" }, { ...cutover, stage: "all", stopEpoch: 0 },
      { ...cutover, stage: "all", stopEpoch: Number.MAX_SAFE_INTEGER + 1 }, { ...cutover, stage: "all", cutoverId: "bad id" },
      { ...cutover, stage: "all", cutoverId: "x".repeat(65) }]) {
      expect((await control(body)).status).toBe(400);
    }
    expect((await control({ ...cutover, stage: "all", cutoverId: "x".repeat(600) })).status).toBe(413);
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const outgoing = request(`${harness.origin}${path}`, { method: "POST", headers }, response => {
        response.resume(); response.once("end", () => resolve(response.statusCode ?? 0));
      });
      outgoing.once("error", reject);
      outgoing.write('{"cutoverId":"'); outgoing.end("x".repeat(600));
    });
    expect(chunkedStatus).toBe(413);
    expect(maintenance.admissionOpen).toBe(true);
    expect((await control({ ...cutover, stage: "all" })).status).toBe(202);
    for (const body of [{ ...cutover, stage: "admission" }, { ...cutover, stage: "all", stopEpoch: 2 },
      { ...cutover, stage: "all", cutoverId: "different" }]) { expect((await control(body)).status).toBe(409); }
    expect((await control({ ...cutover, stage: "all" })).status).toBe(202);
  });

  it("preserves settings during admission, accepts upstream receipts, then waits for an admitted receipt during all", async () => {
    const port = createFakeResultNotificationsPort({ now: () => notificationNow });
    const committed = deferred<void>(); const started = deferred<void>(); const originalReceive = port.receive;
    port.receive = async (...args) => { started.resolve(); await committed.promise; return originalReceive(...args); };
    const maintenance: MaintenanceDrain = createMaintenanceDrain([
      { name: "notifications", stage: "all", stop: () => undefined, drain: () => harness.receiver.drainBusiness() }
    ]);
    harness = await createHttpHarness({ port, maintenance });
    const before = await port.getSetting("ocr_completed");
    expect((await control({ ...cutover, stage: "admission" })).status).toBe(202);
    const setting = await fetch(`${harness.origin}/internal/discord-notifications/settings/ocr_completed`, {
      method: "PATCH", headers, body: '{"enabled":false}'
    });
    expect(setting.status).toBe(503); expect(await port.getSetting("ocr_completed")).toStrictEqual(before);
    const receipt = fetch(`${harness.origin}/internal/discord-notifications`, {
      method: "POST", headers: { ...headers, authorization: `Bearer ${receiverToken}` }, body: JSON.stringify(ocrReceiptPayload())
    });
    try {
      await started.promise;
      expect((await control({ ...cutover, stage: "all" })).status).toBe(202);
      const status = await fetch(`${harness.origin}${path}`, { headers });
      expect(await status.json()).toMatchObject({ stage: "all", phase: "draining" });
      expect((await fetch(`${harness.origin}/internal/discord-notifications`, {
        method: "POST", headers: { ...headers, authorization: `Bearer ${receiverToken}` }, body: JSON.stringify(ocrReceiptPayload())
      })).status).toBe(503);
    } finally { committed.resolve(); }
    expect((await receipt).status).toBe(202); await setImmediate();
    const status = await fetch(`${harness.origin}${path}`, { headers });
    expect(await status.json()).toMatchObject({ stage: "all", phase: "drained" });
    expect(await port.getSetting("ocr_completed")).toStrictEqual(before);
  });

  it("retains an operations write admitted before the cutoff until its commit settles", async () => {
    const port = createFakeResultNotificationsPort({ now: () => notificationNow });
    const commit = deferred<void>(); const started = deferred<void>(); const originalSetting = port.setSetting;
    port.setSetting = async (...args) => { started.resolve(); await commit.promise; return originalSetting(...args); };
    const maintenance = createMaintenanceDrain([
      { name: "operations", stage: "admission", stop: () => undefined, drain: () => harness.receiver.drainOperations() }
    ]);
    harness = await createHttpHarness({ port, maintenance });
    const pending = fetch(`${harness.origin}/internal/discord-notifications/settings/ocr_completed`, {
      method: "PATCH", headers, body: '{"enabled":false}'
    });
    try {
      await started.promise;
      expect((await control({ ...cutover, stage: "admission" })).status).toBe(202);
      expect(maintenance.snapshot().phase).toBe("draining");
    } finally { commit.resolve(); }
    expect((await pending).status).toBe(200); await setImmediate();
    expect(maintenance.snapshot().phase).toBe("drained");
    expect(await port.getSetting("ocr_completed")).toStrictEqual({ kind: "ocr_completed", enabled: false, generation: "1" });
  });
});
