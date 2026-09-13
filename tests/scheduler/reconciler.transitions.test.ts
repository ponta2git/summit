import { beforeEach, describe, expect, it } from "vitest";

import type { SessionRow } from "../../src/db/rows.js";
import {
  client,
  editCalls,
  extractContent,
  makeMessage,
  resetReconcilerHarness,
  sentMessages,
  setFetchImpl
} from "./reconciler.harness.js";
import { reconcileStrandedCancelled } from "../../src/scheduler/reconciler.js";
import { runOutboxWorkerTick } from "../../src/scheduler/outboxWorker.js";
import { MEMBER_COUNT_EXPECTED } from "../../src/config.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { unwrapResultAsync } from "../helpers/assertions.js";

beforeEach(resetReconcilerHarness);

describe("reconcileStrandedCancelled", () => {
  it("promotes a Friday CANCELLED before the postpone deadline", async () => {
    const session: SessionRow = buildSessionRow({
      id: "c-friday",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "CANCELLED",
      askMessageId: "ask-1",
      cancelReason: "deadline_unanswered"
    });
    // jst: 金曜 21:45 JST。候補日翌日の順延期限より前。
    const now = new Date("2026-04-24T12:45:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });

    const report = await unwrapResultAsync(reconcileStrandedCancelled(client, ctx));
    expect(report.succeeded).toBe(0);
    expect(report.failures).toHaveLength(1);
    await runOutboxWorkerTick(client, ctx);
    await runOutboxWorkerTick(client, ctx);
    const after = await ctx.ports.sessions.findSessionById("c-friday");
    expect({ status: after?.status, postponeMessageId: after?.postponeMessageId }).toStrictEqual({
      status: "POSTPONE_VOTING",
      postponeMessageId: "sent-2"
    });
  });

  it("promotes a Friday CANCELLED past the postpone deadline to COMPLETED", async () => {
    const session = buildSessionRow({
      id: "c-late",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "CANCELLED"
    });
    // jst: 土曜 02:00 JST。順延期限より後。
    const ctx = createTestAppContext({
      now: new Date("2026-04-25T17:00:00.000Z"),
      seed: { sessions: [session] }
    });

    expect((await unwrapResultAsync(reconcileStrandedCancelled(client, ctx))).succeeded).toBe(1);
    expect((await ctx.ports.sessions.findSessionById("c-late"))?.status).toBe("COMPLETED");
  });

  it("promotes a Saturday CANCELLED to COMPLETED regardless of time", async () => {
    const session = buildSessionRow({
      id: "c-sat",
      weekKey: "2026-W17",
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "CANCELLED",
      cancelReason: "saturday_cancelled"
    });
    const ctx = createTestAppContext({
      now: new Date("2026-04-25T12:30:00.000Z"),
      seed: { sessions: [session] }
    });

    expect((await unwrapResultAsync(reconcileStrandedCancelled(client, ctx))).succeeded).toBe(1);
    expect((await ctx.ports.sessions.findSessionById("c-sat"))?.status).toBe("COMPLETED");
  });

  it("does nothing when no CANCELLED sessions exist", async () => {
    const session = buildSessionRow({ id: "a1", status: "ASKING" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect((await unwrapResultAsync(reconcileStrandedCancelled(client, ctx))).succeeded).toBe(0);
    expect((await ctx.ports.sessions.findSessionById("a1"))?.status).toBe("ASKING");
  });
});

describe("stranded CANCELLED Discord cleanup", () => {
  it("disables Friday ASK buttons, then sends settle and postpone messages", async () => {
    const session = buildSessionRow({
      id: "c-fri-ui",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "CANCELLED",
      askMessageId: "ask-fri",
      cancelReason: "deadline_unanswered"
    });
    const ctx = createTestAppContext({
      now: new Date("2026-04-24T12:45:00.000Z"),
      seed: { sessions: [session] }
    });
    setFetchImpl(async (id) => makeMessage(id));

    expect((await unwrapResultAsync(reconcileStrandedCancelled(client, ctx))).succeeded).toBe(1);
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.messageId).toBe("ask-fri");
    await runOutboxWorkerTick(client, ctx);
    await runOutboxWorkerTick(client, ctx);
    expect(sentMessages).toHaveLength(2);
    expect(extractContent(sentMessages[0]?.payload)).toContain(
      `21:30 までに${MEMBER_COUNT_EXPECTED}人分の回答`
    );
    expect(extractContent(sentMessages[0]?.payload)).not.toContain("<@");
    expect(extractContent(sentMessages[1]?.payload)).toContain("<@");
    const after = await ctx.ports.sessions.findSessionById("c-fri-ui");
    expect({ status: after?.status, postponeMessageId: after?.postponeMessageId }).toStrictEqual({
      status: "POSTPONE_VOTING",
      postponeMessageId: "sent-2"
    });
  });

  it("disables Saturday ASK buttons and sends one settle notice before completion", async () => {
    const session = buildSessionRow({
      id: "c-sat-ui",
      weekKey: "2026-W17",
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "CANCELLED",
      askMessageId: "ask-sat",
      cancelReason: "saturday_cancelled"
    });
    const ctx = createTestAppContext({
      now: new Date("2026-04-25T12:30:00.000Z"),
      seed: { sessions: [session] }
    });
    setFetchImpl(async (id) => makeMessage(id));

    expect((await unwrapResultAsync(reconcileStrandedCancelled(client, ctx))).succeeded).toBe(1);
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.messageId).toBe("ask-sat");
    await runOutboxWorkerTick(client, ctx);
    expect(sentMessages).toHaveLength(1);
    expect(extractContent(sentMessages[0]?.payload)).toContain("土曜回も予定がそろわなかった");
    expect((await ctx.ports.sessions.findSessionById("c-sat-ui"))?.status).toBe("COMPLETED");
  });

  it("sends one settle notice for a Friday cancellation past the postpone deadline", async () => {
    const session = buildSessionRow({
      id: "c-late-ui",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "CANCELLED",
      askMessageId: "ask-late",
      cancelReason: "absent"
    });
    const ctx = createTestAppContext({
      now: new Date("2026-04-25T17:00:00.000Z"),
      seed: { sessions: [session] }
    });
    setFetchImpl(async (id) => makeMessage(id));

    expect((await unwrapResultAsync(reconcileStrandedCancelled(client, ctx))).succeeded).toBe(1);
    await runOutboxWorkerTick(client, ctx);
    expect(sentMessages).toHaveLength(1);
    expect(extractContent(sentMessages[0]?.payload)).toContain("予定がそろわなかった");
    expect((await ctx.ports.sessions.findSessionById("c-late-ui"))?.status).toBe("COMPLETED");
  });
});
