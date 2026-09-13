import { EventEmitter } from "node:events";
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { registerInteractionHandlers } from "../../src/discord/shared/dispatcher.ts";
import { rejectMessages } from "../../src/features/interaction-reject/messages.ts";
import { asDiscordClient } from "../helpers/discord.ts";
import { asInteraction, buildAskInteraction, buildButtonInteraction } from "../helpers/interaction.ts";
import { createTestAppContext } from "../testing/index.ts";

const sessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";
const errorPayload = { content: rejectMessages.internalError, flags: MessageFlags.Ephemeral };

describe("interaction failure notification", () => {
  it.each(["ask", "postpone"] as const)("notifies the user when an acknowledged %s button fails in its Effect", async kind => {
    const client = new EventEmitter();
    const context = createTestAppContext();
    context.ports.sessions.findSessionById = async () => { throw new Error("Database unavailable"); };
    let acknowledged = false;
    const base = buildButtonInteraction(`${kind}:${sessionId}:${kind === "ask" ? "t2200" : "ok"}`, {
      acknowledge: async () => { acknowledged = true; }
    });
    const interaction = { ...base, get deferred() { return acknowledged; }, replied: false,
      isMessageComponent: () => true, isRepliable: () => true };
    const registration = registerInteractionHandlers(asDiscordClient(client), context);
    try {
      client.emit("interactionCreate", asInteraction(interaction));
      await registration.drain();
      expect(interaction.deferUpdate).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledExactlyOnceWith(errorPayload);
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(context.ports.outbox.listEntries()).toStrictEqual([]);
    } finally { registration.stop(); }
  });

  it.each(["success", "failure"] as const)("contains a post-reply defect and notification %s without rejecting drain", async delivery => {
    const client = new EventEmitter(); let replied = false;
    const base = buildAskInteraction();
    if (delivery === "failure") { base.followUp.mockRejectedValueOnce(new Error("Notification unavailable")); }
    const interaction = { ...base, get replied() { return replied; }, deferred: false,
      isMessageComponent: () => false, isRepliable: () => true };
    const handle = vi.fn(async (request: ChatInputCommandInteraction) => {
      await request.reply({ content: "Started", flags: MessageFlags.Ephemeral });
      replied = true;
      throw new Error("Unexpected handler defect");
    });
    const builder = new SlashCommandBuilder().setName("ask").setDescription("Test route");
    const registration = registerInteractionHandlers(asDiscordClient(client), createTestAppContext(), {
      registry: { resolveCommand: () => ({ name: "ask", handle, builder }), resolveButton: () => undefined, slashBuilders: [builder] }
    });
    try {
      client.emit("interactionCreate", asInteraction(interaction));
      await expect(registration.drain()).resolves.toBeUndefined();
      expect(interaction.reply).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledExactlyOnceWith(errorPayload);
    } finally { registration.stop(); }
  });
});
