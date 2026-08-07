import { beforeEach, describe, expect, it } from "vitest";

import { REMINDER_CLAIM_STALENESS_MS } from "../../src/config.js";
import {
  client,
  makeSendableClient,
  resetReconcilerHarness,
  sentMessages
} from "./reconciler.harness.js";
import {
  reconcileMissingAsk,
  reconcileMissingAskMessage,
  reconcileStaleReminderClaims,
  runReconciler
} from "../../src/scheduler/reconciler.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "./factories/session.js";

beforeEach(resetReconcilerHarness);

describe("reconcileMissingAsk", () => {
  it("creates a Friday ASKING session when none exists after 08:00 JST", async () => {
    const ctx = createTestAppContext({ now: new Date("2026-04-24T01:00:00.000Z") });

    expect(await reconcileMissingAsk(makeSendableClient(), ctx)).toBe(1);
    const sessions = ctx.ports.sessions.listSessions();
    expect(sessions).toHaveLength(1);
    expect({ status: sessions[0]?.status, postponeCount: sessions[0]?.postponeCount })
      .toStrictEqual({ status: "ASKING", postponeCount: 0 });
  });

  it("does nothing on Friday before 08:00 JST", async () => {
    const ctx = createTestAppContext({ now: new Date("2026-04-23T22:30:00.000Z") });

    expect(await reconcileMissingAsk(client, ctx)).toBe(0);
    expect(ctx.ports.sessions.listSessions()).toStrictEqual([]);
  });

  it("does nothing on non-Friday days", async () => {
    const ctx = createTestAppContext({ now: new Date("2026-04-23T03:00:00.000Z") });

    expect(await reconcileMissingAsk(client, ctx)).toBe(0);
    expect(ctx.ports.sessions.listSessions()).toStrictEqual([]);
  });

  it("does not duplicate an existing Friday session", async () => {
    const existing = buildSessionRow({
      id: "existing",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "ASKING",
      askMessageId: "m-1"
    });
    const ctx = createTestAppContext({
      now: new Date("2026-04-24T01:00:00.000Z"),
      seed: { sessions: [existing] }
    });

    expect(await reconcileMissingAsk(client, ctx)).toBe(0);
    expect(ctx.ports.sessions.listSessions()).toHaveLength(1);
  });
});

describe("reconcileMissingAskMessage", () => {
  it("re-sends an ASKING message with a null id and persists the new id", async () => {
    const session = buildSessionRow({ id: "a-null", status: "ASKING", askMessageId: null });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect(await reconcileMissingAskMessage(client, ctx)).toBe(1);
    expect((await ctx.ports.sessions.findSessionById("a-null"))?.askMessageId).toBe("sent-1");
    expect(sentMessages).toHaveLength(1);
  });

  it("re-sends a POSTPONE_VOTING ask message with a null id", async () => {
    const session = buildSessionRow({
      id: "pv-null",
      status: "POSTPONE_VOTING",
      askMessageId: null,
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect(await reconcileMissingAskMessage(client, ctx)).toBe(1);
    expect((await ctx.ports.sessions.findSessionById("pv-null"))?.askMessageId).toBe("sent-1");
  });

  it("skips sessions that already have an ask message id", async () => {
    const session = buildSessionRow({ id: "a-ok", status: "ASKING", askMessageId: "existing-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect(await reconcileMissingAskMessage(client, ctx)).toBe(0);
    expect(sentMessages).toStrictEqual([]);
  });
});

describe("reconcileStaleReminderClaims", () => {
  it("reverts claims at or beyond the staleness boundary", async () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    const staleAt = new Date(now.getTime() - REMINDER_CLAIM_STALENESS_MS);
    const session = buildSessionRow({
      id: "stale",
      status: "DECIDED",
      reminderAt: new Date(now.getTime() - 60_000),
      reminderSentAt: staleAt
    });
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });

    expect(await reconcileStaleReminderClaims(ctx)).toBe(1);
    expect((await ctx.ports.sessions.findSessionById("stale"))?.reminderSentAt).toBeNull();
  });

  it("does not revert a claim one millisecond inside the staleness window", async () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    const freshAt = new Date(now.getTime() - REMINDER_CLAIM_STALENESS_MS + 1);
    const session = buildSessionRow({
      id: "fresh",
      status: "DECIDED",
      reminderAt: new Date(now.getTime() - 60_000),
      reminderSentAt: freshAt
    });
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });

    expect(await reconcileStaleReminderClaims(ctx)).toBe(0);
    expect((await ctx.ports.sessions.findSessionById("fresh"))?.reminderSentAt).toStrictEqual(freshAt);
  });
});

describe("runReconciler tick scope", () => {
  it("only touches stale reminder claims", async () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    const cancelled = buildSessionRow({
      id: "c-sat",
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "CANCELLED"
    });
    const reminderSession = buildSessionRow({
      id: "stale",
      status: "DECIDED",
      reminderAt: new Date(now.getTime() - 60_000),
      reminderSentAt: new Date(now.getTime() - REMINDER_CLAIM_STALENESS_MS)
    });
    const ctx = createTestAppContext({ now, seed: { sessions: [cancelled, reminderSession] } });

    expect(await runReconciler(client, ctx, { scope: "tick" })).toStrictEqual({
      cancelledPromoted: 0,
      askCreated: 0,
      messageResent: 0,
      staleClaimReclaimed: 1,
      outboxClaimReleased: 0
    });
    expect((await ctx.ports.sessions.findSessionById("c-sat"))?.status).toBe("CANCELLED");
  });
});
