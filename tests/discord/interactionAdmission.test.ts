import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { INTERACTION_CONCURRENCY, INTERACTION_REJECTION_CONCURRENCY } from "../../src/config.ts";
import { registerInteractionHandlers } from "../../src/discord/shared/dispatcher.ts";
import { rejectMessages } from "../../src/features/interaction-reject/messages.ts";
import { asDiscordClient } from "../helpers/discord.ts";
import { asInteraction, buildAskInteraction, buildButtonInteraction } from "../helpers/interaction.ts";
import { deferred } from "../helpers/deferred.ts";
import { createTestAppContext } from "../testing/index.ts";

const buttonRegistry = (handle: (interaction: ButtonInteraction) => Promise<void>) => ({
  resolveCommand: () => undefined,
  resolveButton: () => ({ customIdPrefix: "test:", handle }),
  slashBuilders: []
});

describe("bounded interaction admission", () => {
  it("bounds both handler and rejection I/O during a burst and drains both after stop", async () => {
    const client = new EventEmitter();
    const context = createTestAppContext();
    const ack = deferred<void>();
    const releaseHandlers = deferred<void>();
    const releaseRejections = deferred<void>();
    const databaseRead = vi.spyOn(context.ports.members, "listMembers");
    const handle = vi.fn(async () => { await databaseRead(); await releaseHandlers.promise; });
    const registration = registerInteractionHandlers(asDiscordClient(client), context, { registry: buttonRegistry(handle) });
    const lateListener = client.listeners("interactionCreate")[0]!;
    const interactions = Array.from({ length: 100 }, () => {
      const interaction = buildButtonInteraction("test:button", { acknowledge: () => ack.promise });
      interaction.followUp.mockImplementation(async () => { await releaseRejections.promise; });
      return interaction;
    });
    let draining: Promise<void> | undefined;
    try {
      for (const interaction of interactions) { client.emit("interactionCreate", asInteraction(interaction)); }
      await setImmediate();
      expect(interactions.reduce((count, interaction) => count + interaction.deferUpdate.mock.calls.length, 0))
        .toBe(INTERACTION_CONCURRENCY + INTERACTION_REJECTION_CONCURRENCY);
      expect(databaseRead).not.toHaveBeenCalled();
      expect(handle).not.toHaveBeenCalled();

      ack.resolve();
      await setImmediate();
      expect(handle).toHaveBeenCalledTimes(INTERACTION_CONCURRENCY);
      expect(databaseRead).toHaveBeenCalledTimes(INTERACTION_CONCURRENCY);
      const busyPayloads = interactions.flatMap(interaction => interaction.followUp.mock.calls.map(([payload]) => payload));
      expect(busyPayloads).toStrictEqual(Array.from({ length: INTERACTION_REJECTION_CONCURRENCY }, () => ({
        content: rejectMessages.busy, flags: MessageFlags.Ephemeral
      })));

      registration.stop();
      const late = buildButtonInteraction("test:button");
      lateListener(asInteraction(late));
      expect(late.deferUpdate).not.toHaveBeenCalled();
      expect(client.listenerCount("interactionCreate")).toBe(0);
      let drained = false;
      draining = registration.drain().then(() => { drained = true; return undefined; });
      releaseHandlers.resolve();
      await setImmediate();
      expect(drained).toBe(false);
      releaseRejections.resolve();
      await draining;
      expect(drained).toBe(true);
    } finally {
      registration.stop();
      ack.resolve(); releaseHandlers.resolve(); releaseRejections.resolve();
      await (draining ?? registration.drain());
    }
  });

  it("releases failed rejection slots and accepts new work after handler settlement", async () => {
    const client = new EventEmitter();
    const release = deferred<void>();
    const handle = vi.fn(async () => { await release.promise; });
    const registration = registerInteractionHandlers(asDiscordClient(client), createTestAppContext(), { registry: buttonRegistry(handle) });
    try {
      for (let index = 0; index < INTERACTION_CONCURRENCY; index += 1) {
        client.emit("interactionCreate", asInteraction(buildButtonInteraction("test:button")));
      }
      const rejected = Array.from({ length: INTERACTION_REJECTION_CONCURRENCY }, () => buildAskInteraction({
        acknowledge: async () => { throw new Error("Discord unavailable"); }
      }));
      for (const interaction of rejected) { client.emit("interactionCreate", asInteraction(interaction)); }
      await setImmediate();
      expect(rejected.flatMap(interaction => interaction.reply.mock.calls)).toHaveLength(INTERACTION_REJECTION_CONCURRENCY);
      const retried = buildAskInteraction();
      client.emit("interactionCreate", asInteraction(retried));
      await setImmediate();
      expect(retried.reply).toHaveBeenCalledExactlyOnceWith({ content: rejectMessages.busy, flags: MessageFlags.Ephemeral });
      release.resolve();
      await registration.drain();
      const next = buildButtonInteraction("test:button");
      client.emit("interactionCreate", asInteraction(next));
      await registration.drain();
      expect(handle).toHaveBeenCalledTimes(INTERACTION_CONCURRENCY + 1);
      expect(next.followUp).not.toHaveBeenCalled();
    } finally {
      registration.stop(); release.resolve(); await registration.drain();
    }
  });
});
