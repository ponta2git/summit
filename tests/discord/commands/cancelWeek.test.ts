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
import { buildSessionRow } from "../factories/session.js";
import { createTestAppContext, type TestAppContext } from "../../testing/index.js";

// why: render は pure builder (ADR-0028) なので stub 不要。Fake ports の state と outbox entries を直接検証する。
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
    deadlineAt: new Date("2026-04-24T12:30:00.000Z"),
    ...overrides
  });

const createDiscordClient = () => {
  const askEdit = vi.fn(async () => undefined);
  const postponeEdit = vi.fn(async () => undefined);
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
  sendAsk: vi.fn(async () => ({ status: "queued" as const, weekKey: "2026-W17" })),
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
    `cancel_week:${nonce}:confirm`;
  const abortCustomId = (nonce = "d8b1f8e5-1111-4222-8333-123456789abc"): string =>
    `cancel_week:${nonce}:abort`;

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

  it("confirm: transitions current-week non-terminal sessions to SKIPPED and edits ephemeral", async () => {
    const friSession = currentWeekSession({ id: "11111111-aaaa-4bbb-8ccc-000000000001" });
    const satSession = currentWeekSession({
      id: "11111111-aaaa-4bbb-8ccc-000000000002",
      postponeCount: 1,
      status: "POSTPONE_VOTING",
      postponeMessageId: "postpone-msg-2",
      askMessageId: "ask-msg-2"
    });
    const now = new Date("2026-04-24T10:00:00.000Z");
    const ctx = createTestAppContext({
      seed: { sessions: [friSession, satSession], members: seededMembers },
      now
    });
    const { client, channelSend } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    expect(ctx.ports.sessions.listSessions().map((session) => ({
      id: session.id,
      status: session.status,
      cancelReason: session.cancelReason,
      updatedAt: session.updatedAt
    }))).toStrictEqual([
      {
        id: friSession.id,
        status: "SKIPPED",
        cancelReason: "manual_skip",
        updatedAt: now
      },
      {
        id: satSession.id,
        status: "SKIPPED",
        cancelReason: "manual_skip",
        updatedAt: now
      }
    ]);

    expect(channelSend).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries().map((notice) => ({
      kind: notice.kind,
      sessionId: notice.sessionId,
      dedupeKey: notice.dedupeKey,
      payload: notice.payload,
      status: notice.status,
      attemptCount: notice.attemptCount
    }))).toStrictEqual([{
      kind: "send_message",
      sessionId: friSession.id,
      dedupeKey: `cancel-week-notice-${friSession.weekKey}`,
      payload: {
        kind: "send_message",
        channelId: appConfig.discord.channelId,
        renderer: "cancel_week_notice",
        extra: {
          invokerUserId: appConfig.memberUserIds[0],
          suppressMentions: appConfig.dev.suppressMentions
        }
      },
      status: "PENDING",
      attemptCount: 0
    }]);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(editReplyPayload(interaction)).toStrictEqual({
      content: cancelWeekMessages.cancelWeek.done({ count: 2 }),
      components: []
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

  it("confirm with no active session: creates a durable SKIPPED sentinel and notice", async () => {
    const ctx = createTestAppContext({
      seed: { sessions: [], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client, channelSend } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    expect(channelSend).not.toHaveBeenCalled();
    expect(ctx.ports.sessions.listSessions()).toHaveLength(1);
    expect(ctx.ports.sessions.listSessions()[0]).toMatchObject({
      weekKey: "2026-W17",
      postponeCount: 0,
      status: "SKIPPED",
      cancelReason: "manual_skip",
      revision: 1
    });
    expect(ctx.ports.outbox.listEntries()).toHaveLength(1);
    expect(ctx.ports.outbox.listEntries()[0]).toMatchObject({
      sessionId: ctx.ports.sessions.listSessions()[0]!.id,
      dedupeKey: "cancel-week-notice-2026-W17",
      status: "PENDING"
    });
    expect(editReplyPayload(interaction)).toStrictEqual({
      content: cancelWeekMessages.cancelWeek.done({ count: 1 }),
      components: []
    });
  });

  it("confirm: reports failure when orchestration cannot enqueue the notice", async () => {
    const session = currentWeekSession({ id: "11111111-aaaa-4bbb-8ccc-000000000003" });
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

  it("idempotent: confirm on already-SKIPPED sessions repairs but never duplicates the notice", async () => {
    const session = currentWeekSession({ status: "SKIPPED", cancelReason: "manual_skip" });
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client, channelSend } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));
    const secondInteraction = buildCancelButtonInteraction(confirmCustomId());
    await handleInteraction(asInteraction(secondInteraction), buildDeps(client, ctx));

    expect(channelSend).not.toHaveBeenCalled();
    expect(ctx.ports.sessions.listSessions()).toStrictEqual([session]);
    expect(ctx.ports.outbox.listEntries()).toHaveLength(1);
    expect(ctx.ports.outbox.listEntries()[0]?.dedupeKey).toBe(
      `cancel-week-notice-${session.weekKey}`
    );
    expect(editReplyPayload(interaction)).toStrictEqual({
      content: cancelWeekMessages.cancelWeek.done({ count: 0 }),
      components: []
    });
  });
});
