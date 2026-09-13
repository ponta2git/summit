import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { registerInteractionHandlers } from "../../src/discord/shared/dispatcher.ts";
import { asDiscordClient } from "../helpers/discord.ts";
import { asInteraction, buildAskInteraction } from "../helpers/interaction.ts";
import { deferred } from "../helpers/deferred.ts";
import { createTestAppContext } from "../testing/index.ts";

describe("interaction lifetime", () => {
  it("stops accepting new work and drains an already acknowledged handler", async () => {
    const client = new EventEmitter(); const entered = deferred<void>(); const release = deferred<void>();
    const handle = vi.fn(async (interaction: ChatInputCommandInteraction) => {
      await interaction.deferReply(); entered.resolve(); await release.promise;
    });
    const builder = new SlashCommandBuilder().setName("ask").setDescription("Test route");
    const registration = registerInteractionHandlers(asDiscordClient(client), createTestAppContext(), {
      registry: { resolveCommand: () => ({ name: "ask", handle, builder }), resolveButton: () => undefined, slashBuilders: [builder] }
    });
    client.emit("interactionCreate", asInteraction(buildAskInteraction()));
    await entered.promise;
    registration.stop();
    client.emit("interactionCreate", asInteraction(buildAskInteraction()));
    let drained = false; const draining = registration.drain().then(() => { drained = true; return undefined; });
    await setImmediate();
    try { expect(drained).toBe(false); expect(handle).toHaveBeenCalledOnce(); }
    finally { release.resolve(); await draining; }
    expect(drained).toBe(true);
    expect(client.listenerCount("interactionCreate")).toBe(0);
  });
});
