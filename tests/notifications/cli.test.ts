import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNotificationOperation, runNotificationCli } from "../../src/notifications/cli.run.ts";
import { createHttpHarness, operationsToken } from "./http.harness.ts";
import { notificationNow, ocrReceiptPayload } from "../contracts/resultNotifications.ts";

describe("notification operations CLI", () => {
  let harness: Awaited<ReturnType<typeof createHttpHarness>>;
  afterEach(async () => { await harness?.close(); });
  it("selects only explicit inspect/retry/settings operations and encodes the ID", () => {
    expect(buildNotificationOperation(["retry", "result:ocr_completed:job-1"]))
      .toEqual({ path: "/internal/discord-notifications/result%3Aocr_completed%3Ajob-1/retry", method: "POST" });
    expect(() => buildNotificationOperation(["retry", "../../../other"])).toThrow("Usage");
    expect(() => buildNotificationOperation(["retry", "result:ocr_completed:job\n"])).toThrow("Usage");
    expect(() => buildNotificationOperation(["settings", "ocr_completed", "maybe"])).toThrow("Usage");
  });
  it("refuses to send its token to a public endpoint or a credential-bearing URL", async () => {
    for (const url of ["https://example.com", "http://example.com", "http://user:pass@localhost:8081"] ) {
      await expect(runNotificationCli(["settings", "ocr_completed"], { RESULT_NOTIFICATION_OPERATIONS_TOKEN: operationsToken,
        RESULT_NOTIFICATION_URL: url })).rejects.toThrow("private HTTP service origin");
    }
  });
  it("inspects and explicitly retries the same retained failure through the receiver", async () => {
    harness = await createHttpHarness(); const payload = ocrReceiptPayload();
    await harness.port.receive(JSON.stringify(payload), notificationNow);
    const [entry] = await harness.port.claim({ limit: 1, now: notificationNow, claimDurationMs: 30_000 });
    if (!entry) { throw new Error("Expected claim"); }
    await harness.port.fail(entry.id, entry.claimToken, "delivery_failed", null, notificationNow);
    const env = { RESULT_NOTIFICATION_OPERATIONS_TOKEN: operationsToken, RESULT_NOTIFICATION_URL: harness.origin };
    const output = vi.fn();
    await runNotificationCli(["inspect", entry.id], env, output);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ notificationId: entry.id, status: "FAILED", retryable: true });
    await runNotificationCli(["retry", entry.id], env, output);
    expect(await harness.port.inspect(entry.id)).toMatchObject({ status: "PENDING", retryCycle: 1 });
    expect(harness.wake).toHaveBeenCalledWith("retry_committed");
    await expect(runNotificationCli(["retry", entry.id], env, output)).rejects.toThrow("HTTP 409");
  });
});
