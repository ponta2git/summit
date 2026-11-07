import { describe, expect, it, vi } from "vitest";
import type { EnqueueOutboxInput } from "../../src/db/ports.ts";
import { runOutboxWorkerTick } from "../../src/notifications/delivery/composition.attendance.ts";
import { createTestAppContext } from "../testing/index.ts";
import { runEffect } from "../helpers/assertions.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.ts";

const weeklyNotice = (weekKey: string, ordinal = 0): EnqueueOutboxInput => ({
  kind: "send_message", sessionId: null, weekKey, dedupeKey: `weekly-${weekKey}-${ordinal}`,
  aggregateRevision: 0, ordinal,
  payload: { kind: "send_message", channelId: "channel-1", renderer: "weekly_ask_disabled",
    extra: { invokerUserId: "user-1", suppressMentions: true } }
});

describe("weekly outbox without a Session", () => {
  it("retries the weekly notice and confirms delivery without Session reads or backfill", async () => {
    let now = new Date("2026-04-24T12:00:00Z");
    const ctx = createTestAppContext({ now: () => now });
    const findSession = vi.spyOn(ctx.ports.sessions, "findSessionById");
    const backfill = vi.spyOn(ctx.ports.sessions, "backfillAskMessageId");
    await ctx.ports.outbox.enqueue(weeklyNotice("2026-W17"));
    const { channel, sentMessages } = stubChannel();
    channel.send.mockRejectedValueOnce(new Error("temporary Discord failure"));
    await runEffect(runOutboxWorkerTick(stubClient(channel), ctx));
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ sessionId: null, weekKey: "2026-W17",
      status: "PENDING", attemptCount: 1, nextAttemptAt: new Date("2026-04-24T12:00:01Z") });
    now = new Date("2026-04-24T12:00:01Z");
    await runEffect(runOutboxWorkerTick(stubClient(channel), ctx));
    expect(sentMessages).toStrictEqual([{ id: "posted-1", payload: {
      content: "🛑 2026-W17 の金曜自動募集はお休みです。手動募集は利用できます。（実行: user-1）",
      nonce: expect.stringMatching(/^[\w-]{25}$/), enforceNonce: true
    } }]);
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ status: "DELIVERED", attemptCount: 2,
      deliveredMessageId: "posted-1" });
    expect(findSession).not.toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
  });

  it("keeps week ordering, failure cancellation and startup recovery separate from other owners", async () => {
    const now = new Date("2026-04-24T12:00:00Z");
    const ctx = createTestAppContext({ now });
    const first = await ctx.ports.outbox.enqueue(weeklyNotice("2026-W17"));
    const successor = await ctx.ports.outbox.enqueue(weeklyNotice("2026-W17", 1));
    const otherWeek = await ctx.ports.outbox.enqueue(weeklyNotice("2026-W18", 1));
    const session = await ctx.ports.outbox.enqueue({ kind: "send_message", sessionId: "session-1",
      dedupeKey: "session-notice", aggregateRevision: 0, ordinal: 1, payload: weeklyNotice("2026-W17").payload });
    const claims = await ctx.ports.outbox.claimNextBatch({ limit: 10, now, claimDurationMs: 30_000 });
    expect(new Set(claims.map(entry => entry.id))).toStrictEqual(new Set([first.id, otherWeek.id, session.id]));
    const firstClaim = claims.find(entry => entry.id === first.id);
    if (!firstClaim?.claimToken) { throw new Error("Expected weekly claim"); }
    await ctx.ports.outbox.markFailed(first.id, { claimToken: firstClaim.claimToken, now,
      error: "fixed after restart", nextAttemptAt: null });
    expect(ctx.ports.outbox.listEntries().find(entry => entry.id === successor.id)?.status).toBe("CANCELLED");
    expect(ctx.ports.outbox.listEntries().find(entry => entry.id === otherWeek.id)?.status).toBe("IN_FLIGHT");
    expect(await ctx.ports.outbox.findStranded(5)).toMatchObject([{ id: first.id, sessionId: null, weekKey: "2026-W17" }]);
    expect(await ctx.ports.outbox.requeueFailedChains(now)).toStrictEqual({ deadLettersRequeued: 1, successorsRequeued: 1 });
    expect((await ctx.ports.outbox.claimNextBatch({ limit: 10, now, claimDurationMs: 30_000 })).map(entry => entry.id))
      .toStrictEqual([first.id]);
  });

  it.each(["ask_body", "settle_notice", "postpone_vote", "decided_announcement", "reminder", "cancel_week_notice"])(
    "dead-letters Session renderer %s with a weekly owner before send", async renderer => {
      const ctx = createTestAppContext();
      const input = weeklyNotice("2026-W17");
      await ctx.ports.outbox.enqueue({ ...input, payload: { ...input.payload, renderer } });
      const { channel } = stubChannel();
      await runEffect(runOutboxWorkerTick(stubClient(channel), ctx));
      expect(channel.send).not.toHaveBeenCalled();
      expect(ctx.ports.outbox.listEntries()[0]?.status).toBe("FAILED");
    }
  );

  it("rejects a weekly delivery with a Session backfill target before sending", async () => {
    const ctx = createTestAppContext();
    const input = weeklyNotice("2026-W17");
    await ctx.ports.outbox.enqueue({ ...input, payload: { ...input.payload, target: "askMessageId" } });
    const { channel } = stubChannel();
    await runEffect(runOutboxWorkerTick(stubClient(channel), ctx));
    expect(channel.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()[0]?.status).toBe("FAILED");
  });
});
