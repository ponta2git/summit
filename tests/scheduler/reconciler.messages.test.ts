import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";

import {
  isUnknownMessageError
} from "../../src/discord/shared/discordErrors.js";
import {
  client,
  editCalls,
  fetchedMessageIds,
  makeMessage,
  resetReconcilerHarness,
  sentMessages,
  setFetchImpl
} from "./reconciler.harness.js";
import { updateAskMessage } from "../../src/features/ask-session/messageEditor.js";
import { probeDeletedMessagesAtStartup } from "../../src/scheduler/reconciler.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { runEffect } from "../helpers/assertions.js";
import { deferred } from "../helpers/deferred.ts";

beforeEach(resetReconcilerHarness);

describe("isUnknownMessageError", () => {
  it("matches Discord code 10008", () => {
    expect(isUnknownMessageError({ code: 10008 })).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect([
      isUnknownMessageError(new Error("boom")),
      isUnknownMessageError({ code: 50001 }),
      isUnknownMessageError(null),
      isUnknownMessageError(undefined)
    ]).toStrictEqual([false, false, false, false]);
  });
});

describe("updateAskMessage recovery", () => {
  it("recreates the message when Discord returns Unknown Message", async () => {
    const session = buildSessionRow({ id: "s-10008", status: "ASKING", askMessageId: "old-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async () => {
      throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    });

    await runEffect(updateAskMessage(client, ctx, session));

    expect((await ctx.ports.sessions.findSessionById("s-10008"))?.askMessageId).toBe("sent-1");
    expect(sentMessages).toHaveLength(1);
    expect(editCalls).toStrictEqual([]);
  });

  it("propagates non-10008 errors without changing the old id", async () => {
    const session = buildSessionRow({ id: "s-other", status: "ASKING", askMessageId: "old-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async () => {
      throw Object.assign(new Error("Missing Access"), { code: 50001 });
    });

    const result = await runEffect(Effect.either(updateAskMessage(client, ctx, session)));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) {throw new Error("Expected ask message update to fail.");}
    expect(result.left.cause).toMatchObject({ code: 50001 });

    expect((await ctx.ports.sessions.findSessionById("s-other"))?.askMessageId).toBe("old-id");
    expect(sentMessages).toStrictEqual([]);
  });

  it("edits an existing message without recreating it", async () => {
    const session = buildSessionRow({ id: "s-ok", status: "ASKING", askMessageId: "keep-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async (id) => makeMessage(id));

    await runEffect(updateAskMessage(client, ctx, session));

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.messageId).toBe("keep-id");
    expect(sentMessages).toStrictEqual([]);
    expect((await ctx.ports.sessions.findSessionById("s-ok"))?.askMessageId).toBe("keep-id");
  });

  it("keeps database failures classified as DATABASE", async () => {
    const session = buildSessionRow({ id: "s-db-fail", status: "ASKING", askMessageId: "old-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    vi.spyOn(ctx.ports.members, "listMembers").mockRejectedValue(new Error("db unavailable"));

    const result = await runEffect(Effect.either(updateAskMessage(client, ctx, session)));

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) {throw new Error("Expected ask message update to fail.");}
    expect(result.left.code).toBe("DATABASE");
  });
});

describe("probeDeletedMessagesAtStartup", () => {
  it("recreates a missing ASKING message", async () => {
    const session = buildSessionRow({
      id: "probe-ask-gone",
      status: "ASKING",
      askMessageId: "gone-ask-id"
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async () => {
      throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    });

    expect((await runEffect(probeDeletedMessagesAtStartup(client, ctx))).succeeded).toBe(1);
    expect(fetchedMessageIds).toStrictEqual(["gone-ask-id"]);
    expect(sentMessages).toHaveLength(1);
    expect((await ctx.ports.sessions.findSessionById("probe-ask-gone"))?.askMessageId).toBe("sent-1");
  });

  it("recreates only a missing postpone message", async () => {
    const session = buildSessionRow({
      id: "probe-postpone-gone",
      status: "POSTPONE_VOTING",
      askMessageId: "ask-ok",
      postponeMessageId: "gone-postpone-id"
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async (id) => {
      if (id === "gone-postpone-id") {
        throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      }
      return makeMessage(id);
    });

    expect((await runEffect(probeDeletedMessagesAtStartup(client, ctx))).succeeded).toBe(1);
    expect(new Set(fetchedMessageIds)).toStrictEqual(new Set(["ask-ok", "gone-postpone-id"]));
    const after = await ctx.ports.sessions.findSessionById("probe-postpone-gone");
    expect({ askMessageId: after?.askMessageId, postponeMessageId: after?.postponeMessageId })
      .toStrictEqual({ askMessageId: "ask-ok", postponeMessageId: "sent-1" });
  });

  it("does nothing when fetched messages exist", async () => {
    const session = buildSessionRow({ id: "probe-fresh", status: "ASKING", askMessageId: "fresh-ask-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async (id) => makeMessage(id));

    expect((await runEffect(probeDeletedMessagesAtStartup(client, ctx))).succeeded).toBe(0);
    expect(sentMessages).toStrictEqual([]);
    expect(editCalls).toStrictEqual([]);
    expect(ctx.ports.responses.calls).not.toContainEqual(expect.objectContaining({ name: "listResponses" }));
    expect((await ctx.ports.sessions.findSessionById("probe-fresh"))?.askMessageId).toBe("fresh-ask-id");
  });

  it("restores a completed postpone vote with disabled buttons and its final footer", async () => {
    const session = buildSessionRow({ status: "POSTPONED", askMessageId: null, postponeMessageId: "deleted-vote" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async () => { throw Object.assign(new Error("Unknown Message"), { code: 10008 }); });

    expect((await runEffect(probeDeletedMessagesAtStartup(client, ctx))).succeeded).toBe(1);
    const payload: unknown = JSON.parse(JSON.stringify(sentMessages[0]?.payload));
    expect(payload).toMatchObject({ content: expect.stringContaining("明日の出欠確認へ進みます"),
      components: [{ components: [{ disabled: true }, { disabled: true }] }] });
  });

  it("shares replacement ownership with an in-flight message update", async () => {
    const session = buildSessionRow({ askMessageId: "deleted-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const entered = deferred<void>(); const release = deferred<void>(); let blocked = false;
    setFetchImpl(async id => {
      if (id !== "deleted-id") { return makeMessage(id); }
      if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
      throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    });
    const update = runEffect(updateAskMessage(client, ctx, session));
    await entered.promise;
    const probe = runEffect(probeDeletedMessagesAtStartup(client, ctx));
    await setImmediate();
    try { expect(fetchedMessageIds).toStrictEqual(["deleted-id"]); }
    finally { release.resolve(); await Promise.all([update, probe]); }
    expect(sentMessages).toHaveLength(1);
    expect(fetchedMessageIds).toStrictEqual(["deleted-id", "sent-1"]);
    expect(editCalls).toStrictEqual([]);
    expect((await ctx.ports.sessions.findSessionById(session.id))?.askMessageId).toBe("sent-1");
  });

  it("skips a null ask message id without probing Discord", async () => {
    const session = buildSessionRow({ id: "probe-null", status: "ASKING", askMessageId: null });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect((await runEffect(probeDeletedMessagesAtStartup(client, ctx))).succeeded).toBe(0);
    expect(fetchedMessageIds).toStrictEqual([]);
  });
});
