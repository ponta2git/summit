import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  enqueueOutbox, findStrandedOutboxEntries, getOutboxMetrics, pruneOutbox, requeueFailedOutboxChains,
  releaseExpiredOutboxClaims, type EnqueueOutboxInput
} from "../../src/db/repositories/outbox.ts";
import { discordNotifications, discordNotificationAttendance, discordNotificationParts, weeklyAskSchedules } from "../../src/db/schema.ts";
import { beginOutboxDelivery, claimNextOutboxBatch, markOutboxDelivered, markOutboxFailed } from "./_notificationClock.ts";
import { createOutboxContractHarness } from "./_outboxContract.ts";
import { isIntegration } from "./_support.ts";

const describeDb = isIntegration ? describe : describe.skip;
const now = new Date("2026-04-24T12:00:00Z");
const weeklyNotice = (weekKey: string, ordinal = 0): EnqueueOutboxInput => ({
  kind: "send_message", sessionId: null, weekKey, dedupeKey: `weekly-${weekKey}-${ordinal}`,
  aggregateRevision: 0, ordinal, payload: { kind: "send_message", renderer: "weekly_ask_disabled",
    channelId: "channel-1", extra: { invokerUserId: "user-1", suppressMentions: true } }
});

describeDb("weekly attendance outbox ownership (integration)", () => {
  const harness = createOutboxContractHarness();
  const { db, baseSession, basePayload } = harness;
  beforeAll(() => harness.initialize());
  beforeEach(async () => {
    await harness.reset();
    await db.insert(weeklyAskSchedules).values([
      { weekKey: "2026-W17", disabledAt: now, disabledBy: "user-1" },
      { weekKey: "2026-W18", disabledAt: now, disabledBy: "user-1" }
    ]).onConflictDoNothing();
  });

  const enqueue = async (input: EnqueueOutboxInput) => {
    const result = await enqueueOutbox(db, input);
    await db.update(discordNotifications).set({ nextAttemptAt: now }).where(eq(discordNotifications.id, result.id));
    return result;
  };
  const claim = (at = now) => claimNextOutboxBatch(db, { limit: 10, now: at, claimDurationMs: 30_000 });

  it("claims distinct owners independently and restores only the failed week's successors", async () => {
    const first = await enqueue(weeklyNotice("2026-W17"));
    const successor = await enqueue(weeklyNotice("2026-W17", 1));
    const otherWeek = await enqueue(weeklyNotice("2026-W18", 1));
    const session = await enqueue({ kind: "send_message", sessionId: baseSession.id, payload: basePayload,
      dedupeKey: "session-notice", aggregateRevision: 0, ordinal: 1 });
    const claims = await claim();
    expect(new Set(claims.map(entry => entry.id))).toStrictEqual(new Set([first.id, otherWeek.id, session.id]));
    const firstClaim = claims.find(entry => entry.id === first.id);
    if (!firstClaim?.claimToken) { throw new Error("Expected weekly claim"); }
    expect(firstClaim).toMatchObject({ sessionId: null, weekKey: "2026-W17", ordinal: 0 });
    expect(await markOutboxFailed(db, first.id, { claimToken: firstClaim.claimToken, now,
      error: "fixed after restart", nextAttemptAt: null })).toBe(true);
    const statuses = await db.select({ id: discordNotifications.id, status: discordNotifications.status })
      .from(discordNotifications).where(inArray(discordNotifications.id, [successor.id, otherWeek.id, session.id]));
    expect(new Map(statuses.map(row => [row.id, row.status]))).toStrictEqual(new Map([
      [successor.id, "CANCELLED"], [otherWeek.id, "IN_FLIGHT"], [session.id, "IN_FLIGHT"]
    ]));
    expect(await findStrandedOutboxEntries(db, 5)).toMatchObject([{ id: first.id, sessionId: null, weekKey: "2026-W17" }]);
    expect(await getOutboxMetrics(db, now)).toMatchObject({ failed: 1, inFlight: 2, pending: 0 });
    expect(await requeueFailedOutboxChains(db, now)).toStrictEqual({ deadLettersRequeued: 1, successorsRequeued: 1 });
    expect(await requeueFailedOutboxChains(db, now)).toStrictEqual({ deadLettersRequeued: 0, successorsRequeued: 0 });
    expect((await claim()).map(entry => entry.id)).toStrictEqual([first.id]);
  });

  it("reclaims, retries, delivers and purges a weekly notice while retaining dedupe identity", async () => {
    const input = weeklyNotice("2026-W17");
    const { id } = await enqueue(input);
    const [expired] = await claim();
    if (!expired?.claimToken) { throw new Error("Expected weekly claim"); }
    const later = new Date(now.getTime() + 30_000);
    expect(await releaseExpiredOutboxClaims(db, later)).toBe(1);
    const [retry] = await claim(later);
    if (!retry?.claimToken) { throw new Error("Expected retry claim"); }
    expect(await beginOutboxDelivery(db, id, { claimToken: expired.claimToken, now: later })).toBe(false);
    expect(await markOutboxFailed(db, id, { claimToken: retry.claimToken, now: later,
      error: "transient", nextAttemptAt: later })).toBe(true);
    const [current] = await claim(later);
    if (!current?.claimToken) { throw new Error("Expected delivery claim"); }
    expect(current.attemptCount).toBe(3);
    expect(await beginOutboxDelivery(db, id, { claimToken: current.claimToken, now: later })).toBe(true);
    expect(await markOutboxDelivered(db, id, { claimToken: current.claimToken, now: later,
      deliveredMessageId: "weekly-message" })).toBe(true);
    const [part] = await db.select().from(discordNotificationParts).where(eq(discordNotificationParts.notificationId, id));
    expect(part).toMatchObject({ status: "DELIVERED", deliveredMessageId: "weekly-message" });
    expect(await pruneOutbox(db, { deliveredOlderThan: later, failedOlderThan: later }))
      .toStrictEqual({ deliveredPruned: 1, failedPruned: 0, cancelledPruned: 0 });
    expect(await enqueueOutbox(db, input)).toStrictEqual({ id, skipped: true });
    const [relation] = await db.select().from(discordNotificationAttendance)
      .where(eq(discordNotificationAttendance.notificationId, id));
    expect(relation).toMatchObject({ sessionId: null, weekKey: "2026-W17" });
  });

  it("rejects absent or dual owners and duplicate revision/ordinal within a week", async () => {
    const input = weeklyNotice("2026-W17");
    // @ts-expect-error: Deliberate untyped caller verifies the runtime guard as well as the owner type.
    await expect(enqueueOutbox(db, { kind: "send_message", sessionId: null, payload: basePayload,
      dedupeKey: "missing-owner", aggregateRevision: 0, ordinal: 0 })).rejects.toThrow("exactly one owner");
    // @ts-expect-error: Deliberate dual-owner fixture must remain invalid at both boundaries.
    await expect(enqueueOutbox(db, { ...input, sessionId: baseSession.id })).rejects.toThrow("exactly one owner");
    await enqueue(input);
    await expect(enqueueOutbox(db, { ...input, dedupeKey: "duplicate-week-order" })).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await enqueueOutbox(db, input)).toMatchObject({ skipped: true });
  });
});
