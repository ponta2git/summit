import { afterEach, describe, expect, it } from "vitest";
import { RESULT_NOTIFICATION_MAX_BODY_BYTES } from "../../src/config.ts";
import { ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { createHttpHarness, operationsToken, receiverToken, sendRawRequest } from "./http.harness.ts";

describe("internal notification HTTP boundary", () => {
  let harness: Awaited<ReturnType<typeof createHttpHarness>>;
  afterEach(async () => { await harness?.close(); });
  const post = (body: unknown, token = receiverToken) => fetch(`${harness.origin}/internal/discord-notifications`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body)
  });

  it("returns 202 only for a committed new receipt, then 200 for duplicates", async () => {
    harness = await createHttpHarness();
    const payload = ocrReceiptPayload();
    const accepted = await post(payload); expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ notificationId: payload.notificationId, disposition: "accepted", status: "PENDING" });
    const duplicate = await post(payload); expect(duplicate.status).toBe(200); await duplicate.arrayBuffer();
    expect(harness.wake).toHaveBeenCalledTimes(2);
  });

  it("separates producer authorization from operations, and sheds work while unready", async () => {
    let ready = false;
    harness = await createHttpHarness({ canAccept: () => ready });
    expect((await post(ocrReceiptPayload(), "wrong-token")).status).toBe(401);
    expect((await post(ocrReceiptPayload())).status).toBe(503);
    ready = true;
    expect((await post(ocrReceiptPayload())).status).toBe(202);
    const path = `${harness.origin}/internal/discord-notifications/${encodeURIComponent(ocrReceiptPayload().notificationId)}`;
    expect((await fetch(path, { headers: { authorization: `Bearer ${receiverToken}` } })).status).toBe(401);
    const state = await fetch(path, { headers: { authorization: `Bearer ${operationsToken}` } });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ status: "PENDING", retryable: false });
  });

  it("maps validation, version, identity and body limits to stable errors", async () => {
    harness = await createHttpHarness(); const payload = ocrReceiptPayload();
    expect((await post({ ...payload, schemaVersion: 2 })).status).toBe(422);
    expect((await post({ ...payload, settingsGeneration: "bad" })).status).toBe(400);
    expect((await post({ ...payload, sourceJobId: "job\n", notificationId: "result:ocr_completed:job\n" })).status).toBe(400);
    expect(await sendRawRequest(harness.origin, Buffer.from("{broken"))).toBe(400);
    expect(await sendRawRequest(harness.origin, Buffer.from([0xff]))).toBe(400);
    expect(await sendRawRequest(harness.origin, Buffer.from("{}"), { "content-length": String(RESULT_NOTIFICATION_MAX_BODY_BYTES + 1) })).toBe(413);
    expect((await post(payload)).status).toBe(202);
    expect((await post({ ...payload, schemaVersion: 2 })).status).toBe(409);
  });

  it("offers authenticated settings and retries through committed application commands", async () => {
    harness = await createHttpHarness(); const payload = ocrReceiptPayload(); await post(payload);
    const settings = `${harness.origin}/internal/discord-notifications/settings/ocr_completed`;
    const headers = { authorization: `Bearer ${operationsToken}`, "content-type": "application/json" };
    const off = await fetch(settings, { method: "PATCH", headers, body: '{"enabled":false}' });
    expect(off.status).toBe(200); expect(await off.json()).toEqual({ kind: "ocr_completed", enabled: false, generation: "1" });
    const retry = await fetch(`${harness.origin}/internal/discord-notifications/${encodeURIComponent(payload.notificationId)}/retry`, { method: "POST", headers });
    expect(retry.status).toBe(409); expect(await retry.json()).toEqual({ error: "retry_ineligible" });
    expect(await harness.port.inspect(payload.notificationId)).toMatchObject({ status: "CANCELLED" });
  });

  it("rejects a public bind and keeps error details out of responses and logs", async () => {
    harness = await createHttpHarness();
    await expect(harness.receiver.start("0.0.0.0", 0)).rejects.toThrow("private or loopback");
    harness.port.receive = async () => { throw new Error("private SQL bind canary"); };
    const result = await post(ocrReceiptPayload()); expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain("canary");
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain(receiverToken);
  });
});
