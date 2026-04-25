import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { handleStatusCommand } from "../../../src/features/status-command/handler.js";
import { appConfig } from "../../../src/userConfig.js";
import type { AppContext } from "../../../src/appContext.js";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/interactionHandlerDeps.js";
import { callArg } from "../../helpers/assertions.js";
import { createClientWithChannel } from "../../helpers/discord.js";
import { memberUserId } from "../../helpers/env.js";
import { makeSession } from "../../testing/fixtures.js";
import { createTestAppContext } from "../../testing/ports.js";
import { rejectMessages } from "../../../src/features/interaction-reject/messages.js";

const buildInteraction = (override: {
  readonly guildId?: string | null;
  readonly channelId?: string | null;
  readonly userId?: string;
} = {}) => ({
  id: "interaction-status",
  commandName: "status",
  guildId: override.guildId ?? appConfig.discord.guildId,
  channelId: override.channelId ?? appConfig.discord.channelId,
  user: { id: override.userId ?? memberUserId },
  deferReply: vi.fn(async () => undefined),
  editReply: vi.fn(async () => undefined)
});

const editReplyContent = (interaction: ReturnType<typeof buildInteraction>): string =>
  callArg<{ content: string }>(interaction.editReply).content;

const buildDeps = (context: AppContext): InteractionHandlerDeps => ({
  context,
  client: createClientWithChannel(undefined),
  sendAsk: vi.fn(async () => ({ status: "skipped" as const, weekKey: "2026-W17" }))
});

const handleStatus = (
  interaction: ReturnType<typeof buildInteraction>,
  context: AppContext
): Promise<void> =>
  handleStatusCommand(interaction as unknown as ChatInputCommandInteraction, buildDeps(context));

describe("handleStatusCommand", () => {
  it("regression: returns promptly even when 0 non-terminal sessions exist (must not throw)", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction();

    await expect(
      handleStatus(interaction, ctx)
    ).resolves.not.toThrow();

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(editReplyContent(interaction)).toContain("非終端セッション: なし");
  });

  it("returns session info for an ASKING session", async () => {
    const session = makeSession({ status: "ASKING", askMessageId: "msg-1" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const interaction = buildInteraction();

    await handleStatus(interaction, ctx);

    expect(editReplyContent(interaction)).toContain("[ASKING]");
  });

  it("rejects a non-member user ephemerally", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction({ userId: "000000000000000001" });

    await handleStatus(interaction, ctx);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("メンバー")
    );
    expect(ctx.ports.sessions.calls.some((c) => c.name === "findNonTerminalSessions")).toBe(false);
  });

  it("rejects a wrong channel interaction ephemerally", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction({ channelId: "000000000000000001" });

    await handleStatus(interaction, ctx);

    expect(interaction.editReply).toHaveBeenCalledWith(rejectMessages.reject.wrongChannel);
    expect(ctx.ports.sessions.calls.some((c) => c.name === "findNonTerminalSessions")).toBe(false);
  });

  it("rejects a wrong guild interaction ephemerally", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction({ guildId: "000000000000000001" });

    await handleStatus(interaction, ctx);

    expect(interaction.editReply).toHaveBeenCalledWith(rejectMessages.reject.wrongGuild);
    expect(ctx.ports.sessions.calls.some((c) => c.name === "findNonTerminalSessions")).toBe(false);
  });

  it("returns an internal error message when status DB loading fails", async () => {
    const ctx = createTestAppContext({ seed: {} });
    Object.assign(ctx.ports.sessions, {
      findNonTerminalSessions: vi.fn(async () => {
        throw new Error("database unavailable");
      })
    });
    const interaction = buildInteraction();

    await handleStatus(interaction, ctx);

    expect(interaction.editReply).toHaveBeenCalledWith(rejectMessages.internalError);
  });

  it("surfaces invariant warning when ASKING session has past deadline and null messageId", async () => {
    const now = new Date("2026-04-25T12:30:00.000Z");
    const session = makeSession({
      status: "ASKING",
      deadlineAt: new Date("2026-04-25T12:00:00.000Z"), // past
      askMessageId: null
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] }, now });
    const interaction = buildInteraction();

    await handleStatus(interaction, ctx);

    expect(editReplyContent(interaction)).toContain("⚠");
  });

  it("does not show stranded CANCELLED section when there are none", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction();

    await handleStatus(interaction, ctx);

    expect(editReplyContent(interaction)).not.toContain("宙づり CANCELLED");
  });

  it("shows stranded CANCELLED section and warning when stranded sessions exist", async () => {
    const strandedSession = makeSession({ id: "cancelled-session-1a", status: "CANCELLED" });
    const ctx = createTestAppContext({ seed: { sessions: [strandedSession] } });
    const interaction = buildInteraction();

    await handleStatus(interaction, ctx);

    const content = editReplyContent(interaction);
    expect(content).toContain("宙づり CANCELLED");
    expect(content).toContain("⚠");
    expect(content).toContain("cancell");
  });

  it("includes stranded CANCELLED in total warning count", async () => {
    const strandedSession1 = makeSession({ id: "cancelled-s1-xxxx", status: "CANCELLED" });
    const strandedSession2 = makeSession({ id: "cancelled-s2-xxxx", status: "CANCELLED" });
    const ctx = createTestAppContext({ seed: { sessions: [strandedSession1, strandedSession2] } });
    const interaction = buildInteraction();

    await handleStatus(interaction, ctx);

    expect(
      ctx.ports.sessions.calls.some((c) => c.name === "findStrandedCancelledSessions")
    ).toBe(true);
    expect(editReplyContent(interaction)).toContain("2");
  });
});
