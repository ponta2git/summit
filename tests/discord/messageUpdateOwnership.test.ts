import { setImmediate } from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { serializeMessageUpdate } from "../../src/discord/shared/messageUpdates.ts";
import { fromDiscordCall } from "../../src/errors/effect.ts";
import { updateAskMessage } from "../../src/features/ask-session/messageEditor.ts";
import { updatePostponeMessage } from "../../src/features/postpone-voting/messageEditor.ts";
import { runEffect } from "../helpers/assertions.ts";
import { deferred } from "../helpers/deferred.ts";
import { createDiscordTextFixture, createEditableMessage } from "../helpers/discord.ts";
import { createTestAppContext } from "../testing/index.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";

describe("message update ownership", () => {
  it("cancels a waiter without releasing the active update's lock or starting cancelled work", async () => {
    const context = createTestAppContext();
    const entered = deferred<void>(); const release = deferred<void>();
    const completed: string[] = [];
    const owner = runEffect(serializeMessageUpdate(context, "message", () => fromDiscordCall(async () => {
      entered.resolve(); await release.promise; completed.push("owner");
    }, "Edit failed.")));
    await entered.promise;
    const waiter = Effect.runFork(serializeMessageUpdate(context, "message", () =>
      Effect.sync(() => { completed.push("cancelled"); })));
    let follower: Promise<void> | undefined;
    try {
      await setImmediate();
      await runEffect(Fiber.interrupt(waiter));
      follower = runEffect(serializeMessageUpdate(context, "message", () =>
        Effect.sync(() => { completed.push("follower"); })));
      await setImmediate();
      expect(completed).toStrictEqual([]);
    } finally {
      release.resolve();
      await Promise.all([owner, follower, runEffect(Fiber.interrupt(waiter))]);
    }
    expect(completed).toStrictEqual(["owner", "follower"]);
  });

  it.each(["ask", "postpone"] as const)("persists a recreated %s message ID before honoring interruption", async kind => {
    const session = buildSessionRow({ status: kind === "ask" ? "ASKING" : "POSTPONE_VOTING",
      askMessageId: "deleted-id", postponeMessageId: "deleted-id" });
    const context = createTestAppContext({ seed: { sessions: [session] } });
    const sending = deferred<void>(); const releaseSend = deferred<void>();
    const saving = deferred<void>(); const releaseSave = deferred<void>();
    const fixture = createDiscordTextFixture(async () => {
      sending.resolve(); await releaseSend.promise; return { id: "replacement-id" };
    });
    fixture.fetch.mockImplementation(async id => {
      if (id === "deleted-id") { throw Object.assign(new Error("Deleted message"), { code: 10008 }); }
      return createEditableMessage(id);
    });
    const save = kind === "ask" ? context.ports.sessions.updateAskMessageId : context.ports.sessions.updatePostponeMessageId;
    const delayedSave: typeof save = async (id, messageId) => {
      saving.resolve(); await releaseSave.promise; return save(id, messageId);
    };
    if (kind === "ask") { context.ports.sessions.updateAskMessageId = delayedSave; }
    else { context.ports.sessions.updatePostponeMessageId = delayedSave; }
    const update = kind === "ask" ? updateAskMessage : updatePostponeMessage;
    const operation = update(fixture.client, context, session);
    expect(fixture.fetch).not.toHaveBeenCalled();
    const fiber = Effect.runFork(operation);
    let interrupted: Promise<unknown> | undefined;
    let completed = false;
    try {
      await sending.promise;
      interrupted = runEffect(Fiber.interrupt(fiber)).then(exit => { completed = true; return exit; });
      releaseSend.resolve();
      await Promise.race([
        saving.promise,
        interrupted.then(() => { throw new Error("Interrupted before saving the sent message ID."); })
      ]);
      expect(completed).toBe(false);
      releaseSave.resolve();
      await interrupted;
      const persisted = context.ports.sessions.listSessions()[0]!;
      expect(kind === "ask" ? persisted.askMessageId : persisted.postponeMessageId).toBe("replacement-id");
      await runEffect(update(fixture.client, context, session));
      expect(fixture.send).toHaveBeenCalledOnce();
      expect(fixture.fetch.mock.calls.map(call => call[0])).toStrictEqual(["deleted-id", "replacement-id"]);
    } finally {
      releaseSend.resolve(); releaseSave.resolve();
      await (interrupted ?? runEffect(Fiber.interrupt(fiber)));
    }
  });
});
