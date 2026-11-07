import { ChannelType, MessageFlags, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { handleInteraction } from "../../../src/discord/shared/dispatcher.js";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/dispatcher.js";
import type { SessionRow } from "../../../src/db/rows.js";
import { appConfig } from "../../../src/userConfig.js";
import { cancelWeekMessages } from "../../../src/features/cancel-week/messages.js";
import { callArg } from "../../helpers/assertions.js";
import { asInteraction, buildCancelInteraction } from "../../helpers/interaction.js";
import { asDiscordClient } from "../../helpers/discord.js";
import { buildSessionRow } from "../../testing/sessionScenario.ts";
import { createTestAppContext, type TestAppContext } from "../../testing/index.js";

// why: render は pure builder なので stub 不要。Fake ports の state と outbox entries を直接検証する。
const seededMembers = appConfig.memberUserIds.map((userId, index) => ({
  id: `member-${index}`,
  userId,
  displayName: `Member ${index + 1}`
}));

const currentWeekSession = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({
    id: "4f7d54aa-3898-4a13-9f7c-5872a8220e0f",
    status: "ASKING",
    postponeCount: 0,
    askMessageId: "ask-msg-1",
    ...overrides
  });

const createDiscordClient = () => {
  const askEdit = vi.fn(async (_payload: unknown) => undefined);
  const postponeEdit = vi.fn(async (_payload: unknown) => undefined);
  const channelSend = vi.fn(async () => ({ id: "notice-1" }));
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: channelSend,
    messages: {
      fetch: vi.fn(async (id: string) => ({
        edit: id === "ask-msg-1" ? askEdit : postponeEdit
      }))
    }
  };

  const client = asDiscordClient({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  });

  return { client, askEdit, postponeEdit, channelSend };
};

const buildDeps = (
  client: Client,
  context: TestAppContext
): InteractionHandlerDeps => ({
  sendAsk: vi.fn(async () => ({ status: "queued" as const, weekKey: "2026-W17", sessionId: "session-1" })),
  client,
  context
});

const editReplyPayload = (interaction: { readonly editReply: ReturnType<typeof vi.fn> }) =>
  callArg<{ readonly content: string; readonly components?: readonly unknown[] }>(
    interaction.editReply
  );

describe("/cancel_week command flow", () => {
  it("opens ephemeral confirmation dialog with confirm/abort buttons", async () => {
    const ctx = createTestAppContext({
      seed: { sessions: [currentWeekSession()], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client } = createDiscordClient();
    const interaction = buildCancelInteraction();

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const editCall = callArg<{
      content: string;
      components: readonly unknown[];
    }>(interaction.editReply);
    expect(editCall.content).toBe(cancelWeekMessages.cancelWeek.confirmPrompt);
    expect(editCall.components).toHaveLength(1);
  });
});

describe("cancel_week confirmation button", () => {
  const confirmCustomId = (nonce = "d8b1f8e5-1111-4222-8333-123456789abc"): string =>
    `cancel_week:2026-W17:${nonce}:confirm`;
  const abortCustomId = (nonce = "d8b1f8e5-1111-4222-8333-123456789abc"): string =>
    `cancel_week:2026-W17:${nonce}:abort`;

  const buildCancelButtonInteraction = (customId: string) => ({
    id: "interaction-cancel-btn",
    customId,
    guildId: appConfig.discord.guildId,
    channelId: appConfig.discord.channelId,
    user: { id: appConfig.memberUserIds[0] },
    isChatInputCommand: () => false,
    isButton: () => true,
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined)
  });

  it("confirm preserves created auto, postponed child and messages", async () => {
    const friday = currentWeekSession({ status: "POSTPONED" });
    const saturday = currentWeekSession({ id: "saturday", source: "postponed", parentSessionId: friday.id,
      candidateDateIso: "2026-04-25", postponeCount: 1 });
    const ctx = createTestAppContext({ seed: { sessions: [friday, saturday], members: seededMembers },
      now: new Date("2026-04-24T10:00:00Z") });
    const { client, askEdit, postponeEdit } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());
    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));
    expect(ctx.ports.sessions.listSessions()).toStrictEqual([friday, saturday]);
    expect(ctx.ports.outbox.listEntries()).toStrictEqual([]);
    expect(askEdit).not.toHaveBeenCalled();
    expect(postponeEdit).not.toHaveBeenCalled();
    expect(editReplyPayload(interaction)).toStrictEqual({
      content: cancelWeekMessages.cancelWeek.done("already_started"), components: []
    });
  });

  it("abort: no state changes and ephemeral updated to aborted message", async () => {
    const session = currentWeekSession();
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client, channelSend } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(abortCustomId());

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    expect(ctx.ports.sessions.listSessions()).toStrictEqual([session]);
    expect(channelSend).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()).toStrictEqual([]);
    expect(editReplyPayload(interaction)).toStrictEqual({
      content: cancelWeekMessages.cancelWeek.aborted,
      components: []
    });
  });

  it("confirm persists a weekly stop with no Session and replay creates no extra notice", async () => {
    const ctx = createTestAppContext({ seed: { members: seededMembers }, now: new Date("2026-04-24T10:00:00Z") });
    const { client } = createDiscordClient();
    const first = buildCancelButtonInteraction(confirmCustomId());
    await handleInteraction(asInteraction(first), buildDeps(client, ctx));
    expect(ctx.ports.sessions.listSessions()).toStrictEqual([]);
    expect(ctx.ports.sessions.weeklySchedules.get("2026-W17")).toMatchObject({ autoSessionId: null, disabledAt: ctx.clock.now() });
    expect(ctx.ports.outbox.listEntries()).toMatchObject([{ sessionId: null, weekKey: "2026-W17",
      dedupeKey: "weekly-ask-disabled-2026-W17", status: "PENDING" }]);
    expect(editReplyPayload(first)).toStrictEqual({ content: cancelWeekMessages.cancelWeek.done("applied"), components: [] });
    const replay = buildCancelButtonInteraction(confirmCustomId());
    await handleInteraction(asInteraction(replay), buildDeps(client, ctx));
    expect(editReplyPayload(replay)).toStrictEqual({ content: cancelWeekMessages.cancelWeek.done("already_disabled"), components: [] });
    expect(ctx.ports.outbox.listEntries()).toHaveLength(1);
  });

  it("confirm: reports failure when orchestration cannot enqueue the notice", async () => {
    const session = currentWeekSession({ id: "11111111-aaaa-4bbb-8ccc-000000000003", source: "manual" });
    const now = new Date("2026-04-24T10:00:00.000Z");
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now
    });
    Object.assign(ctx.ports.outbox, {
      enqueue: vi.fn(async () => {
        throw new Error("outbox unavailable");
      })
    });
    const { client } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    expect(editReplyPayload(interaction)).toStrictEqual({
      content: cancelWeekMessages.cancelWeek.failed,
      components: []
    });
    expect(ctx.ports.sessions.listSessions().map((persisted) => ({
      id: persisted.id,
      status: persisted.status,
      cancelReason: persisted.cancelReason,
      updatedAt: persisted.updatedAt
    }))).toStrictEqual([{
      id: session.id,
      status: "ASKING",
      cancelReason: null,
      updatedAt: session.updatedAt
    }]);
    expect(ctx.ports.outbox.listEntries()).toStrictEqual([]);
  });

  it("leaves a manual session and its messages usable while stopping auto", async () => {
    const session = currentWeekSession({ source: "manual" });
    const ctx = createTestAppContext({ seed: { sessions: [session], members: seededMembers }, now: new Date("2026-04-24T10:00:00Z") });
    const { client, askEdit, postponeEdit } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());
    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));
    expect(ctx.ports.sessions.listSessions()).toStrictEqual([session]);
    expect(ctx.ports.outbox.listEntries()).toHaveLength(1);
    expect(askEdit).not.toHaveBeenCalled();
    expect(postponeEdit).not.toHaveBeenCalled();
    expect(editReplyPayload(interaction)).toStrictEqual({ content: cancelWeekMessages.cancelWeek.done("applied"), components: [] });
  });
});
