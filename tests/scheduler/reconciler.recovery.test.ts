import { beforeEach, describe, expect, it } from "vitest";

import {
  resetReconcilerHarness,
  sentMessages
} from "./reconciler.harness.js";
import {
  reconcileMissingAsk,
  reconcileMissingMessageIntents
} from "../../src/scheduler/reconciler.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { runEffect } from "../helpers/assertions.js";

beforeEach(resetReconcilerHarness);

describe("reconcileMissingAsk", () => {
  it("creates a Friday ASKING session when none exists after 08:00 JST", async () => {
    const ctx = createTestAppContext({ now: new Date("2026-04-24T01:00:00.000Z") });

    expect(await runEffect(reconcileMissingAsk(ctx))).toBe(1);
    const sessions = ctx.ports.sessions.listSessions();
    expect(sessions).toHaveLength(1);
    expect({ status: sessions[0]?.status, postponeCount: sessions[0]?.postponeCount })
      .toStrictEqual({ status: "ASKING", postponeCount: 0 });
  });

  it("does nothing on Friday before 08:00 JST", async () => {
    const ctx = createTestAppContext({ now: new Date("2026-04-23T22:30:00.000Z") });

    expect(await runEffect(reconcileMissingAsk(ctx))).toBe(0);
    expect(ctx.ports.sessions.listSessions()).toStrictEqual([]);
  });

  it("does nothing on non-Friday days", async () => {
    const ctx = createTestAppContext({ now: new Date("2026-04-23T03:00:00.000Z") });

    expect(await runEffect(reconcileMissingAsk(ctx))).toBe(0);
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

    expect(await runEffect(reconcileMissingAsk(ctx))).toBe(0);
    expect(ctx.ports.sessions.listSessions()).toHaveLength(1);
  });
});

describe("reconcileMissingMessageIntents", () => {
  it("queues an ASKING message intent with a null id without sending directly", async () => {
    const session = buildSessionRow({ id: "a-null", status: "ASKING", askMessageId: null });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect((await runEffect(reconcileMissingMessageIntents(ctx))).succeeded).toBe(1);
    expect((await ctx.ports.sessions.findSessionById("a-null"))?.askMessageId).toBeNull();
    expect(sentMessages).toStrictEqual([]);
    expect(ctx.ports.outbox.listEntries().map((entry) => entry.payload)).toStrictEqual([
      expect.objectContaining({ renderer: "ask_body", target: "askMessageId" })
    ]);
  });

  it("queues both missing ASK and postpone-vote intents in reserved order", async () => {
    const session = buildSessionRow({
      id: "pv-null",
      status: "POSTPONE_VOTING",
      askMessageId: null,
      postponeMessageId: null,
      revision: 4,
      deadlineAt: new Date("2026-04-24T15:00:00.000Z")
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect((await runEffect(reconcileMissingMessageIntents(ctx))).succeeded).toBe(2);
    expect(ctx.ports.outbox.listEntries().map((entry) => ({
      renderer: entry.payload.kind === "send_message" ? entry.payload.renderer : undefined,
      aggregateRevision: entry.aggregateRevision,
      ordinal: entry.ordinal
    }))).toStrictEqual([
      { renderer: "ask_body", aggregateRevision: 4, ordinal: 32_766 },
      { renderer: "postpone_vote", aggregateRevision: 4, ordinal: 32_767 }
    ]);
  });

  it("is idempotent and skips sessions whose message ids are complete", async () => {
    const session = buildSessionRow({ id: "a-ok", status: "ASKING", askMessageId: "existing-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect((await runEffect(reconcileMissingMessageIntents(ctx))).succeeded).toBe(0);
    expect((await runEffect(reconcileMissingMessageIntents(ctx))).succeeded).toBe(0);
    expect(sentMessages).toStrictEqual([]);
  });
});
