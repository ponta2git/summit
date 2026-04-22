import { ChannelType, MessageFlags, type Client, type Interaction } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleInteraction } from "../../../src/discord/shared/dispatcher.js";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/dispatcher.js";
import type { SessionRow } from "../../../src/db/rows.js";
import { env } from "../../../src/env.js";
import { cancelWeekMessages } from "../../../src/features/cancel-week/messages.js";
import { buildCancelInteraction } from "../../helpers/interaction.js";
import { buildSessionRow } from "../factories/session.js";
import { createTestAppContext, type TestAppContext } from "../../testing/index.js";

vi.mock("../../../src/discord/ask/render.js", () => ({
  renderAskBody: vi.fn(() => ({ content: "mocked-ask", components: [] })),
  buildAskRow: vi.fn()
}));

vi.mock("../../../src/discord/postpone/render.js", () => ({
  renderPostponeBody: vi.fn(() => ({ content: "mocked-postpone", components: [] })),
  buildPostponeRow: vi.fn()
}));

const seededMembers = env.MEMBER_USER_IDS.map((userId, index) => ({
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

  const client = {
    channels: {
      fetch: vi.fn(async () => channel)
    }
  } as unknown as Client;

  return { client, askEdit, postponeEdit, channelSend };
};

const buildDeps = (
  client: Client,
  context: TestAppContext
): InteractionHandlerDeps => ({
  sendAsk: vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" })),
  client,
  context
});

describe("/cancel_week command flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens ephemeral confirmation dialog with confirm/abort buttons", async () => {
    const ctx = createTestAppContext({
      seed: { sessions: [currentWeekSession()], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client } = createDiscordClient();
    const interaction = buildCancelInteraction();

    await handleInteraction(interaction as unknown as Interaction, buildDeps(client, ctx));

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const editCall = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      content: string;
      components: readonly unknown[];
    };
    expect(editCall.content).toBe(cancelWeekMessages.cancelWeek.confirmPrompt);
    expect(editCall.components).toHaveLength(1);
  });
});

describe("cancel_week confirmation button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const confirmCustomId = (nonce = "d8b1f8e5-1111-4222-8333-123456789abc"): string =>
    `cancel_week:${nonce}:confirm`;
  const abortCustomId = (nonce = "d8b1f8e5-1111-4222-8333-123456789abc"): string =>
    `cancel_week:${nonce}:abort`;

  const buildCancelButtonInteraction = (customId: string) => ({
    id: "interaction-cancel-btn",
    customId,
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    user: { id: env.MEMBER_USER_IDS[0] },
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
    const ctx = createTestAppContext({
      seed: { sessions: [friSession, satSession], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client, channelSend } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());

    await handleInteraction(interaction as unknown as Interaction, buildDeps(client, ctx));

    const after1 = await ctx.ports.sessions.findSessionById(friSession.id);
    const after2 = await ctx.ports.sessions.findSessionById(satSession.id);
    expect(after1?.status).toBe("SKIPPED");
    expect(after1?.cancelReason).toBe("manual_skip");
    expect(after2?.status).toBe("SKIPPED");
    expect(after2?.cancelReason).toBe("manual_skip");

    expect(channelSend).not.toHaveBeenCalled();
    const outboxEntries = ctx.ports.outbox.listEntries();
    expect(outboxEntries).toHaveLength(1);
    const [notice] = outboxEntries;
    expect(notice?.dedupeKey).toMatch(/^cancel-week-notice-/);
    if (notice?.payload.kind === "send_message") {
      expect(notice.payload.renderer).toBe("cancel_week_notice");
      expect(notice.payload.extra?.["invokerUserId"]).toBe(env.MEMBER_USER_IDS[0]);
    } else {
      throw new Error("expected send_message payload");
    }

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: cancelWeekMessages.cancelWeek.done({ count: 2 }),
        components: []
      })
    );
  });

  it("abort: no state changes and ephemeral updated to aborted message", async () => {
    const session = currentWeekSession();
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client, channelSend } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(abortCustomId());

    await handleInteraction(interaction as unknown as Interaction, buildDeps(client, ctx));

    const after = await ctx.ports.sessions.findSessionById(session.id);
    expect(after?.status).toBe("ASKING");
    expect(channelSend).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()).toHaveLength(0);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: cancelWeekMessages.cancelWeek.aborted,
        components: []
      })
    );
  });

  it("confirm with no active session: ephemeral reports zero targets, no notice sent", async () => {
    const ctx = createTestAppContext({
      seed: { sessions: [], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client, channelSend } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());

    await handleInteraction(interaction as unknown as Interaction, buildDeps(client, ctx));

    expect(channelSend).not.toHaveBeenCalled();
    expect(ctx.ports.outbox.listEntries()).toHaveLength(0);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: cancelWeekMessages.cancelWeek.done({ count: 0 }),
        components: []
      })
    );
  });

  it("idempotent: confirm on already-SKIPPED sessions does not send notice again", async () => {
    const session = currentWeekSession({ status: "SKIPPED", cancelReason: "manual_skip" });
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client, channelSend } = createDiscordClient();
    const interaction = buildCancelButtonInteraction(confirmCustomId());

    await handleInteraction(interaction as unknown as Interaction, buildDeps(client, ctx));

    expect(channelSend).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: cancelWeekMessages.cancelWeek.done({ count: 0 })
      })
    );
  });
});
