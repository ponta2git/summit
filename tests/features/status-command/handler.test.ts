import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { handleStatusCommand } from "../../../src/features/status-command/handler.js";
import { env } from "../../../src/env.js";
import { memberUserId } from "../../helpers/env.js";
import { makeSession } from "../../testing/fixtures.js";
import { createTestAppContext } from "../../testing/ports.js";

const buildInteraction = (override: {
  readonly guildId?: string | null;
  readonly channelId?: string | null;
  readonly userId?: string;
} = {}) => ({
  id: "interaction-status",
  commandName: "status",
  guildId: override.guildId ?? env.DISCORD_GUILD_ID,
  channelId: override.channelId ?? env.DISCORD_CHANNEL_ID,
  user: { id: override.userId ?? memberUserId },
  deferReply: vi.fn(async () => undefined),
  editReply: vi.fn(async () => undefined)
});

describe("handleStatusCommand", () => {
  it("regression: returns promptly even when 0 non-terminal sessions exist (must not throw)", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction();

    await expect(
      handleStatusCommand(interaction as never, ctx)
    ).resolves.not.toThrow();

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const call = interaction.editReply.mock.calls[0] as unknown as [{ content: string }];
    const [content] = call;
    expect(content.content).toContain("非終端セッション: なし");
  });

  it("returns session info for an ASKING session", async () => {
    const session = makeSession({ status: "ASKING", askMessageId: "msg-1" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    const interaction = buildInteraction();

    await handleStatusCommand(interaction as never, ctx);

    const call = interaction.editReply.mock.calls[0] as unknown as [{ content: string }];
    const [content] = call;
    expect(content.content).toContain("[ASKING]");
  });

  it("rejects a non-member user ephemerally", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction({ userId: "000000000000000001" });

    await handleStatusCommand(interaction as never, ctx);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("メンバー")
    );
    // sessions port should NOT be called
    expect(ctx.ports.sessions.calls.some((c) => c.name === "findNonTerminalSessions")).toBe(false);
  });

  it("rejects a wrong channel interaction ephemerally", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction({ channelId: "000000000000000001" });

    await handleStatusCommand(interaction as never, ctx);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("メンバー")
    );
    expect(ctx.ports.sessions.calls.some((c) => c.name === "findNonTerminalSessions")).toBe(false);
  });

  it("rejects a wrong guild interaction ephemerally", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction({ guildId: "000000000000000001" });

    await handleStatusCommand(interaction as never, ctx);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("メンバー")
    );
    expect(ctx.ports.sessions.calls.some((c) => c.name === "findNonTerminalSessions")).toBe(false);
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

    await handleStatusCommand(interaction as never, ctx);

    const call = interaction.editReply.mock.calls[0] as unknown as [{ content: string }];
    const [content] = call;
    expect(content.content).toContain("⚠");
  });

  it("does not show stranded CANCELLED section when there are none", async () => {
    const ctx = createTestAppContext({ seed: {} });
    const interaction = buildInteraction();

    await handleStatusCommand(interaction as never, ctx);

    const call = interaction.editReply.mock.calls[0] as unknown as [{ content: string }];
    const [content] = call;
    expect(content.content).not.toContain("宙づり CANCELLED");
  });

  it("shows stranded CANCELLED section and warning when stranded sessions exist", async () => {
    const strandedSession = makeSession({ id: "cancelled-session-1a", status: "CANCELLED" });
    const ctx = createTestAppContext({ seed: { sessions: [strandedSession] } });
    const interaction = buildInteraction();

    await handleStatusCommand(interaction as never, ctx);

    const call = interaction.editReply.mock.calls[0] as unknown as [{ content: string }];
    const [content] = call;
    expect(content.content).toContain("宙づり CANCELLED");
    expect(content.content).toContain("⚠");
    // session short-id appears in warning message
    expect(content.content).toContain("cancell");
  });

  it("includes stranded CANCELLED in total warning count", async () => {
    const strandedSession1 = makeSession({ id: "cancelled-s1-xxxx", status: "CANCELLED" });
    const strandedSession2 = makeSession({ id: "cancelled-s2-xxxx", status: "CANCELLED" });
    const ctx = createTestAppContext({ seed: { sessions: [strandedSession1, strandedSession2] } });
    const interaction = buildInteraction();

    await handleStatusCommand(interaction as never, ctx);

    // sessions port must have been called for stranded CANCELLED query
    expect(
      ctx.ports.sessions.calls.some((c) => c.name === "findStrandedCancelledSessions")
    ).toBe(true);
    const call = interaction.editReply.mock.calls[0] as unknown as [{ content: string }];
    const [content] = call;
    // The aggregate warning message should mention 2 sessions
    expect(content.content).toContain("2");
  });
});
