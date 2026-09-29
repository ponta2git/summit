import { beforeEach, describe, expect, it } from "vitest";
import { RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES } from "../../src/notifications/config.ts";
import { notificationNow as now } from "../contracts/resultNotifications.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { isIntegration } from "./_support.ts";

(isIntegration ? describe : describe.skip)("result notification claim byte reservations", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); });

  const storedPayload = (jobId: string, note: string) => {
    const base = analysisNotification();
    return { ...base, notificationId: `result:analysis_completed:${jobId}`, sourceJobId: jobId,
      data: { ...base.data, matches: base.data.matches.map(match => ({ ...match, note })) } };
  };

  it("measures JSONB UTF-8 bytes before hydrating and reserves the exact boundary", async () => {
    const payload = storedPayload("unicode", "界😀".repeat(20_000));
    await h.seedStoredNotification(payload);
    const [row] = await h.client`SELECT octet_length(payload::text) AS bytes, length(payload::text) AS characters
      FROM discord_notifications WHERE id = ${payload.notificationId}`;
    if (!row) { throw new Error("Expected stored notification"); }
    const bytes = Number(row["bytes"]);
    expect(bytes).toBeGreaterThan(Number(row["characters"]) * 2);
    const options = { limit: 2, now, claimDurationMs: 30_000, allowOversizedPayload: false };
    expect(await h.port.claim({ ...options, payloadBudgetBytes: bytes - 1 })).toEqual([]);
    expect(await h.port.inspect(payload.notificationId)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    const [entry] = await h.port.claim({ ...options, payloadBudgetBytes: bytes });
    expect(entry).toMatchObject({ payloadBytes: bytes, payload, attemptCount: 1 });
  });

  it("retains an oversized historical notification until an exclusive reservation is available", async () => {
    const legacy = storedPayload("a-legacy", "x".repeat(RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES));
    const normal = storedPayload("b-normal", "Short summary");
    await h.seedStoredNotification(legacy);
    await h.port.receive(JSON.stringify(normal), now);
    const options = { limit: 2, now, claimDurationMs: 30_000, payloadBudgetBytes: RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES };
    const concurrent = await h.port.claim({ ...options, allowOversizedPayload: false });
    expect(concurrent).toEqual([]);
    expect(await h.port.inspect(legacy.notificationId)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    const exclusive = await h.port.claim({ ...options, allowOversizedPayload: true });
    expect(exclusive.map(value => value.id)).toEqual([legacy.notificationId]);
    expect(exclusive[0]?.payloadBytes).toBeGreaterThan(RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES);
    expect(exclusive[0]?.payload).toEqual(legacy);
    expect(await h.port.inspect(normal.notificationId)).toMatchObject({ status: "PENDING", attemptCount: 0 });
    const [entry] = exclusive;
    if (!entry) { throw new Error("Expected legacy claim"); }
    await h.port.fail(entry.id, entry.claimToken, "invalid_payload", null, now);
    expect((await h.port.claim(options)).map(value => value.id)).toEqual([normal.notificationId]);
  });

  it("fills the requested slot after removing exhausted and cancelled heads within a bounded scan", async () => {
    const exhausted = storedPayload("a-exhausted", "Short summary");
    const cancelled = { ...storedPayload("b-stale-generation", "Short summary"), settingsGeneration: "1" };
    const ready = storedPayload("c-ready", "Short summary");
    for (const payload of [exhausted, cancelled, ready]) { await h.seedStoredNotification(payload); }
    await h.client`UPDATE discord_notifications SET attempt_count = max_attempts WHERE id = ${exhausted.notificationId}`;
    const entries = await h.port.claim({ limit: 1, now, claimDurationMs: 30_000, allowOversizedPayload: false });
    expect(entries.map(entry => entry.id)).toEqual([ready.notificationId]);
    expect(await h.port.inspect(exhausted.notificationId)).toMatchObject({ status: "FAILED", lastError: "attempt_limit" });
    expect(await h.port.inspect(cancelled.notificationId)).toMatchObject({ status: "CANCELLED", cancelReason: "stale_generation" });
  });
});
