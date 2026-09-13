import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { handleInteraction } from "../../src/discord/shared/dispatcher.ts";
import { asInteraction, buildAskInteraction, buildButtonInteraction } from "../helpers/interaction.ts";
import { createInteractionResponses } from "../helpers/interactionResponses.ts";
import { deferred } from "../helpers/deferred.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { createMemberSeededContext, defaultInteractionDeps, successfulSendAsk } from "./interactions.harness.ts";

const sessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
const now = new Date("2026-04-24T12:00:00Z");

describe("interaction acknowledgement completion", () => {
  it("starts no button DB or Discord work until deferUpdate resolves", async () => {
    const ack = deferred<void>(); const started = deferred<void>();
    const context = createMemberSeededContext(buildSessionRow({ id: sessionId, askMessageId: "ask-message" }), now);
    const edit = vi.fn(async () => undefined);
    const interaction = { ...buildButtonInteraction(`ask:${sessionId}:t2200`, {
      acknowledge: () => { started.resolve(); return ack.promise; }
    }), message: { edit } };
    const handling = handleInteraction(asInteraction(interaction), defaultInteractionDeps(successfulSendAsk(), context));
    // Observe a complete event-loop turn, not a wall-clock sleep: an unawaited ack lets the whole handler run here.
    await Promise.race([started.promise, handling]); await setImmediate();
    try {
      expect(context.ports.members.calls).toStrictEqual([]);
      expect(context.ports.sessions.calls).toStrictEqual([]);
      expect(context.ports.sessionCommands.calls).toStrictEqual([]);
      expect(edit).not.toHaveBeenCalled();
      expect(interaction.followUp).not.toHaveBeenCalled();
    } finally { ack.resolve(); await handling; }
    expect((await context.ports.responses.listResponses(sessionId)).map(row => row.choice)).toStrictEqual(["T2200"]);
    expect(edit).toHaveBeenCalledOnce();
  });

  it("starts no slash-command work until deferReply resolves", async () => {
    const ack = deferred<void>(); const started = deferred<void>(); const sendAsk = successfulSendAsk();
    const interaction = buildAskInteraction({ acknowledge: () => { started.resolve(); return ack.promise; } });
    const handling = handleInteraction(asInteraction(interaction), defaultInteractionDeps(sendAsk));
    await Promise.race([started.promise, handling]); await setImmediate();
    try { expect(sendAsk).not.toHaveBeenCalled(); expect(interaction.editReply).not.toHaveBeenCalled(); }
    finally { ack.resolve(); await handling; }
    expect(sendAsk).toHaveBeenCalledOnce(); expect(interaction.editReply).toHaveBeenCalledOnce();
  });

  it.each(["button", "command"] as const)("leaves no side effects when %s acknowledgement fails", async kind => {
    const context = createMemberSeededContext(buildSessionRow({ id: sessionId, askMessageId: "ask-message" }), now); const sendAsk = successfulSendAsk();
    const acknowledge = async () => { throw new Error("ack rejected"); };
    const interaction = kind === "button" ? buildButtonInteraction(`ask:${sessionId}:t2200`, { acknowledge }) : buildAskInteraction({ acknowledge });
    const before = context.ports.sessions.listSessions();
    await expect(handleInteraction(asInteraction(interaction), defaultInteractionDeps(sendAsk, context))).rejects.toThrow("ack rejected");
    expect(context.ports.sessions.listSessions()).toStrictEqual(before);
    expect(context.ports.responses.listAllResponses()).toStrictEqual([]);
    expect(context.ports.outbox.listEntries()).toStrictEqual([]);
    expect(sendAsk).not.toHaveBeenCalled(); expect(interaction.editReply).not.toHaveBeenCalled(); expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("rejects follow-ups before acknowledgement and rejects a second initial response", async () => {
    const interaction = createInteractionResponses();
    await expect(interaction.followUp()).rejects.toThrow("has not completed");
    await interaction.deferUpdate();
    await expect(interaction.reply()).rejects.toThrow("already acknowledged");
    await expect(interaction.editReply()).resolves.toBeUndefined();
  });
});
