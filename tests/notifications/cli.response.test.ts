import { afterEach, describe, expect, it, vi } from "vitest";
import { runNotificationCli } from "../../src/notifications/cli.run.ts";
import { RESULT_NOTIFICATION_CLIENT_TIMEOUT_MS, RESULT_NOTIFICATION_RESPONSE_MAX_BYTES } from "../../src/notifications/config.ts";
import { deferred } from "../helpers/deferred.ts";
import { operationsToken } from "./http.harness.ts";

const environment = { RESULT_NOTIFICATION_OPERATIONS_TOKEN: operationsToken, RESULT_NOTIFICATION_URL: "http://127.0.0.1:8081" };
const headers = { "content-type": "application/json" };
describe("notification CLI response boundary", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("accepts JSON at the exact byte limit and preserves split UTF-8", async () => {
    const bytes = Buffer.alloc(RESULT_NOTIFICATION_RESPONSE_MAX_BYTES, " ");
    Buffer.from('{"label":"あ😀"}').copy(bytes);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let offset = 0; offset < 32; offset += 1) { controller.enqueue(bytes.subarray(offset, offset + 1)); }
      for (let offset = 32; offset < bytes.length; offset += 65_536) { controller.enqueue(bytes.subarray(offset, offset + 65_536)); }
      controller.close();
    } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers })));
    const output = vi.fn();
    await runNotificationCli(["settings", "ocr_completed"], environment, output);
    expect(output).toHaveBeenCalledWith(JSON.stringify({ label: "あ😀" }, null, 2));
  });

  it("limits actual streamed bytes despite a misleading content length, then cancels the body", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(RESULT_NOTIFICATION_RESPONSE_MAX_BYTES + 1));
    }, cancel: cancelled });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { ...headers, "content-length": "2" } })));
    const output = vi.fn();
    await expect(runNotificationCli(["settings", "ocr_completed"], environment, output)).rejects.toThrow("exceeded the byte limit");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
  });

  it("keeps the deadline through a stalled body and disposes the stream and timer", async () => {
    vi.useFakeTimers();
    const reading = deferred<void>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel: cancelled });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers })));
    const output = vi.fn();
    const pending = runNotificationCli(["settings", "ocr_completed"], environment, output).catch((error: unknown) => error);
    await reading.promise;
    await vi.advanceTimersByTimeAsync(RESULT_NOTIFICATION_CLIENT_TIMEOUT_MS);
    expect(await pending).toMatchObject({ message: "Notification service response unavailable; inspect the same ID before retrying" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 503])("cancels an HTTP %s body without logging or parsing it", async status => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Buffer.from("DO-NOT-LOG-PRIVATE-RESPONSE"));
    }, cancel: cancelled });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status, headers })));
    const output = vi.fn();
    await expect(runNotificationCli(["settings", "ocr_completed"], environment, output)).rejects.toThrow(`HTTP ${status}`);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
  });

  it("preserves a rejection status even when the peer sends no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(runNotificationCli(["settings", "ocr_completed"], environment, vi.fn())).rejects.toThrow("HTTP 503");
  });

  it.each([Buffer.from("DO-NOT-LOG-PRIVATE-RESPONSE"), Buffer.from([0xff])])("does not expose malformed JSON or UTF-8", async bytes => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes, { headers })));
    await expect(runNotificationCli(["settings", "ocr_completed"], environment, vi.fn()))
      .rejects.toThrow("Invalid notification service response");
  });

  it("rejects an unusable token before constructing a request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const token of [" ".repeat(32), "x".repeat(32) + "\r\n", "界".repeat(32), "x".repeat(513)]) {
      await expect(runNotificationCli(["settings", "ocr_completed"], { ...environment, RESULT_NOTIFICATION_OPERATIONS_TOKEN: token }))
        .rejects.toThrow("A valid RESULT_NOTIFICATION_OPERATIONS_TOKEN");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
