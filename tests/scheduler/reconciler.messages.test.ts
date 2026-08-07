import { beforeEach, describe, expect, it } from "vitest";

import {
  DISCORD_UNKNOWN_MESSAGE_CODE,
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
import { buildSessionRow } from "./factories/session.js";

beforeEach(resetReconcilerHarness);

describe("isUnknownMessageError", () => {
  it("matches Discord code 10008", () => {
    expect(isUnknownMessageError({ code: DISCORD_UNKNOWN_MESSAGE_CODE })).toBe(true);
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

    await updateAskMessage(client, ctx, session);

    expect((await ctx.ports.sessions.findSessionById("s-10008"))?.askMessageId).toBe("sent-1");
    expect(sentMessages).toHaveLength(1);
    expect(editCalls).toStrictEqual([]);
  });

  it("keeps the old id on non-10008 errors", async () => {
    const session = buildSessionRow({ id: "s-other", status: "ASKING", askMessageId: "old-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async () => {
      throw Object.assign(new Error("Missing Access"), { code: 50001 });
    });

    await updateAskMessage(client, ctx, session);

    expect((await ctx.ports.sessions.findSessionById("s-other"))?.askMessageId).toBe("old-id");
    expect(sentMessages).toStrictEqual([]);
  });

  it("edits an existing message without recreating it", async () => {
    const session = buildSessionRow({ id: "s-ok", status: "ASKING", askMessageId: "keep-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async (id) => makeMessage(id));

    await updateAskMessage(client, ctx, session);

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.messageId).toBe("keep-id");
    expect(sentMessages).toStrictEqual([]);
    expect((await ctx.ports.sessions.findSessionById("s-ok"))?.askMessageId).toBe("keep-id");
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

    expect(await probeDeletedMessagesAtStartup(client, ctx)).toBe(1);
    expect(fetchedMessageIds).toStrictEqual(["gone-ask-id"]);
    expect(sentMessages).toHaveLength(1);
    expect((await ctx.ports.sessions.findSessionById("probe-ask-gone"))?.askMessageId).toBe("sent-1");
  });

  it("recreates only a missing postpone message", async () => {
    const session = buildSessionRow({
      id: "probe-postpone-gone",
      status: "POSTPONE_VOTING",
      askMessageId: "ask-ok",
      postponeMessageId: "gone-postpone-id",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async (id) => {
      if (id === "gone-postpone-id") {
        throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      }
      return makeMessage(id);
    });

    expect(await probeDeletedMessagesAtStartup(client, ctx)).toBe(1);
    expect(new Set(fetchedMessageIds)).toStrictEqual(new Set(["ask-ok", "gone-postpone-id"]));
    const after = await ctx.ports.sessions.findSessionById("probe-postpone-gone");
    expect({ askMessageId: after?.askMessageId, postponeMessageId: after?.postponeMessageId })
      .toStrictEqual({ askMessageId: "ask-ok", postponeMessageId: "sent-1" });
  });

  it("does nothing when fetched messages exist", async () => {
    const session = buildSessionRow({ id: "probe-fresh", status: "ASKING", askMessageId: "fresh-ask-id" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    setFetchImpl(async (id) => makeMessage(id));

    expect(await probeDeletedMessagesAtStartup(client, ctx)).toBe(0);
    expect(sentMessages).toStrictEqual([]);
    expect((await ctx.ports.sessions.findSessionById("probe-fresh"))?.askMessageId).toBe("fresh-ask-id");
  });

  it("skips a null ask message id without probing Discord", async () => {
    const session = buildSessionRow({ id: "probe-null", status: "ASKING", askMessageId: null });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    expect(await probeDeletedMessagesAtStartup(client, ctx)).toBe(0);
    expect(fetchedMessageIds).toStrictEqual([]);
  });
});
