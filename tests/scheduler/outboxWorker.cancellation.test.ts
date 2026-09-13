import { runEffect } from "../helpers/assertions.ts";
import { describe, expect, it } from "vitest";
import { runOutboxWorkerTick } from "../../src/scheduler/outboxWorker.js";
import { deferred } from "../helpers/deferred.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { stubChannel, stubClient } from "./outboxWorker.harness.js";

describe("outbox send-start cancellation boundary", () => {
  it("does not post or backfill when cancellation commits while the channel is being resolved", async () => {
    const session = buildSessionRow({ id: "cancel-before-send", status: "ASKING", askMessageId: null });
    const now = new Date("2026-04-24T12:00:00Z");
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    await ctx.ports.outbox.enqueue({
      kind: "send_message", sessionId: session.id, dedupeKey: "cancel-before-send",
      aggregateRevision: 0, ordinal: 0,
      payload: { kind: "send_message", channelId: session.channelId, renderer: "ask_body", target: "askMessageId" }
    });
    const { channel, sentMessages } = stubChannel();
    const channelRequested = deferred<void>();
    const channelReady = deferred<typeof channel>();
    const client = stubClient(channel, async () => {
      channelRequested.resolve();
      return channelReady.promise;
    });
    const tick = runEffect(runOutboxWorkerTick(client, ctx));
    await channelRequested.promise;
    ctx.ports.outbox.cancelForSessionIds([session.id], "unrelated-dedupe", now);
    channelReady.resolve(channel);
    await tick;
    expect(sentMessages).toStrictEqual([]);
    expect(ctx.ports.outbox.listEntries().map(entry => entry.status)).toStrictEqual(["CANCELLED"]);
    expect((await ctx.ports.sessions.findSessionById(session.id))?.askMessageId).toBeNull();
  });
});
