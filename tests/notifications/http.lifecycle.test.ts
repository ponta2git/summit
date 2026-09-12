import { afterEach, describe, expect, it, vi } from "vitest";
import { RESULT_NOTIFICATION_MAX_RECEIPTS, RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "../../src/config.ts";
import { notificationNow, ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { createFakeResultNotificationsPort } from "../testing/ports.resultNotifications.ts";
import { createHttpHarness, receiverToken } from "./http.harness.ts";

describe("notification receipt lifetime", () => {
  let harness: Awaited<ReturnType<typeof createHttpHarness>>;
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const release of releases.splice(0)) { release(); }
    await harness?.close(); vi.useRealTimers();
  });
  const port = () => {
    const value = createFakeResultNotificationsPort({ now: () => notificationNow });
    value.setTargetAvailable("match_draft", "draft-1", true); return value;
  };
  const post = (signal?: AbortSignal) => fetch(`${harness.origin}/internal/discord-notifications`, {
    method: "POST", headers: { authorization: `Bearer ${receiverToken}`, "content-type": "application/json" },
    body: JSON.stringify(ocrReceiptPayload()), ...(signal ? { signal } : {})
  });

  it("cannot acknowledge before the durable receipt resolves, and drain waits for that receipt", async () => {
    const fake = port(); const receive = fake.receive; const entered = deferred<void>(); const release = deferred<void>();
    releases.push(() => release.resolve());
    fake.receive = async (...args) => { entered.resolve(); await release.promise; return receive(...args); };
    harness = await createHttpHarness({ port: fake });
    let responded = false; let drained = false;
    const request = post().then(response => { responded = true; return response; });
    await entered.promise;
    harness.receiver.stop();
    const drain = harness.receiver.drain().then(() => { drained = true; return undefined; });
    await Promise.resolve();
    expect(responded).toBe(false); expect(drained).toBe(false); expect(harness.wake).not.toHaveBeenCalled();
    release.resolve();
    expect((await request).status).toBe(202); await drain;
    expect(drained).toBe(true); expect(harness.wake).toHaveBeenCalledOnce();
    expect(await fake.inspect(ocrReceiptPayload().notificationId)).toMatchObject({ status: "PENDING" });
  });

  it("keeps timed-out DB work within the receipt limit until the commands actually finish", async () => {
    vi.useFakeTimers();
    const fake = port(); const receive = fake.receive; const entered = deferred<void>(); const release = deferred<void>();
    releases.push(() => release.resolve());
    let started = 0;
    fake.receive = async (...args) => { started += 1; if (started === RESULT_NOTIFICATION_MAX_RECEIPTS) { entered.resolve(); }
      await release.promise; return receive(...args); };
    harness = await createHttpHarness({ port: fake });
    const pending = Array.from({ length: RESULT_NOTIFICATION_MAX_RECEIPTS }, () => post());
    await entered.promise;
    expect((await post()).status).toBe(503);
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS);
    expect((await Promise.all(pending)).map(response => response.status)).toEqual(Array(RESULT_NOTIFICATION_MAX_RECEIPTS).fill(503));
    expect((await post()).status).toBe(503); expect(started).toBe(RESULT_NOTIFICATION_MAX_RECEIPTS);
    release.resolve(); await harness.receiver.drain();
    expect(harness.wake).toHaveBeenCalledTimes(RESULT_NOTIFICATION_MAX_RECEIPTS);
    expect((await post()).status).toBe(200);
  });

  it("preserves a committed receipt when the caller disconnects before its response", async () => {
    const fake = port(); const receive = fake.receive; const committed = deferred<void>(); const release = deferred<void>();
    releases.push(() => release.resolve());
    fake.receive = async (...args) => { const receipt = await receive(...args); committed.resolve(); await release.promise; return receipt; };
    harness = await createHttpHarness({ port: fake });
    const controller = new AbortController();
    const request = post(controller.signal).catch(() => null);
    await committed.promise; controller.abort(); await request;
    release.resolve(); await harness.receiver.drain();
    expect(harness.wake).toHaveBeenCalledOnce();
    expect(await fake.inspect(ocrReceiptPayload().notificationId)).toMatchObject({ status: "PENDING" });
    expect((await post()).status).toBe(200);
  });
});
