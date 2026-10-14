import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { describe, expect, it, vi } from "vitest";

import { OUTBOX_CLAIM_DURATION_MS } from "../../src/config.ts";
import { deliverOutboxEntry } from "../../src/notifications/delivery/attendanceDelivery.ts";
import {
  attendanceDefinitions, prepareAttendanceNotification, type AttendanceNotificationRegistry
} from "../../src/notifications/delivery/definitions/attendance.ts";
import { deliverSinglePost, type SinglePostStrategy } from "../../src/notifications/delivery/strategies/singlePost.ts";
import { settledCall } from "../../src/runtime/effect.ts";
import { runEffect } from "../helpers/assertions.ts";
import { stubChannel, stubClient } from "../scheduler/outboxWorker.harness.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";

const claimNotification = async (renderer: string, reminder = false) => {
  let now = new Date("2026-04-24T12:45:00Z");
  const session = reminder
    ? buildSessionRow({ id: "registered-notification", status: "DECIDED", decidedStartAt: new Date("2026-04-24T13:00:00Z"),
        reminderAt: now, reminderSentAt: null })
    : buildSessionRow({ id: "registered-notification", askMessageId: null });
  const ctx = createTestAppContext({ seed: { sessions: [session] }, now: () => now });
  await ctx.ports.outbox.enqueue({ kind: "send_message", sessionId: session.id, dedupeKey: `notification-${renderer}`,
    aggregateRevision: 0, ordinal: 0, payload: { kind: "send_message", renderer, channelId: session.channelId,
      ...(reminder ? {} : { target: "askMessageId" as const }) } });
  const [entry] = await ctx.ports.outbox.claimNextBatch({ limit: 1, now, claimDurationMs: OUTBOX_CLAIM_DURATION_MS });
  if (!entry?.claimToken) { throw new Error("Expected a fenced fixture claim."); }
  const { channel } = stubChannel();
  return { ctx, entry, channel, client: stubClient(channel), session,
    execution: { deliveryId: entry.id, laneId: "attendance" as const, isStopping: () => false },
    advance: () => { now = new Date(now.getTime() + 2_000); } };
};

describe("attendance notification definitions", () => {
  it("delivers an added definition through the production delivery and a substituted single-post strategy", async () => {
    const { ctx, entry, channel, client, session, execution, advance } = await claimNotification("fixture_notice");
    const events: string[] = [];
    const registry: AttendanceNotificationRegistry = {
      ...attendanceDefinitions,
      fixture_notice: {
        render: ({ ctx: context }) => {
          events.push("render");
          return Effect.succeed({ content: `fixture at ${context.clock.now().toISOString()}` });
        },
        confirmBusiness: (context, sessionId, messageId) => Effect.gen(function* () {
          expect([sessionId, messageId]).toEqual([session.id, "fixture-message"]);
          expect((yield* settledCall(() => context.ports.sessions.findSessionById(sessionId)))?.askMessageId).toBeNull();
          events.push("business");
        })
      }
    };
    const strategy: SinglePostStrategy = (input, owner) => Effect.suspend(() => {
      events.push("strategy");
      return deliverSinglePost(input, owner);
    });
    channel.send.mockImplementation(async payload => { events.push("send"); return { id: "fixture-message", payload }; });
    const backfill = ctx.ports.sessions.backfillAskMessageId;
    ctx.ports.sessions.backfillAskMessageId = (...args) => { events.push("backfill"); return backfill(...args); };
    const markDelivered = ctx.ports.outbox.markDelivered;
    ctx.ports.outbox.markDelivered = (...args) => { events.push("delivered"); return markDelivered(...args); };
    const delivery = deliverOutboxEntry(client, ctx, entry, execution, {
      strategy,
      prepareNotification: (context, claim, token) => prepareAttendanceNotification(context, claim, token, registry)
    });
    expect(events).toEqual([]);
    advance();
    await runEffect(delivery);
    expect(events).toEqual(["render", "strategy", "send", "business", "backfill", "delivered"]);
    expect(channel.send).toHaveBeenCalledExactlyOnceWith({ content: "fixture at 2026-04-24T12:45:02.000Z",
      nonce: expect.stringMatching(/^[\w-]{25}$/), enforceNonce: true });
    expect((await ctx.ports.sessions.findSessionById(session.id))?.askMessageId).toBe("fixture-message");
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ status: "DELIVERED", deliveredMessageId: "fixture-message" });
  });

  it("keeps the reminder unacknowledged when its registered business confirmation cannot persist the held event", async () => {
    const { ctx, entry, channel, client, execution } = await claimNotification("reminder", true);
    vi.spyOn(ctx.ports.heldEvents, "completeDecidedSessionAsHeld").mockResolvedValue(undefined);
    const delivered = vi.spyOn(ctx.ports.outbox, "markDelivered");
    await runEffect(deliverOutboxEntry(client, ctx, entry, execution, {
      strategy: deliverSinglePost, prepareNotification: prepareAttendanceNotification
    }));
    expect(channel.send).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
    expect(ctx.ports.heldEvents.listHeldEvents()).toEqual([]);
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ status: "PENDING", deliveredMessageId: null,
      lastError: "Outbox delivery failed.", nextAttemptAt: new Date("2026-04-24T12:45:01Z") });
  });

  it("defers an injected preparer's synchronous defect and never classifies it as a retry", async () => {
    const { ctx, entry, channel, client, execution } = await claimNotification("cancel_week_notice");
    const failure = new TypeError("injected preparation defect");
    const prepare = vi.fn(() => { throw failure; });
    const markFailed = vi.spyOn(ctx.ports.outbox, "markFailed");
    const delivery = deliverOutboxEntry(client, ctx, entry, execution, {
      strategy: deliverSinglePost, prepareNotification: prepare
    });
    expect(prepare).not.toHaveBeenCalled();
    const exit = await runEffect(Effect.exit(delivery));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(markFailed).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it.each(["unregistered_notice", "constructor", "toString"])("dead-letters the unregistered renderer %s without invoking a strategy", async renderer => {
    const { ctx, entry, channel, client, execution } = await claimNotification(renderer);
    const strategyCalled = vi.fn();
    const strategy: SinglePostStrategy = (input, owner) => {
      strategyCalled();
      return deliverSinglePost(input, owner);
    };
    await runEffect(deliverOutboxEntry(client, ctx, entry, execution, { strategy, prepareNotification: prepareAttendanceNotification }));
    expect(strategyCalled).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({ status: "FAILED", lastError: "Unsupported outbox payload." });
  });
});
