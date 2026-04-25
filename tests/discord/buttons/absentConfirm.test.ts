import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleInteraction } from "../../../src/discord/shared/dispatcher.js";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/dispatcher.js";
import { appConfig } from "../../../src/userConfig.js";
import { askMessages } from "../../../src/features/ask-session/messages.js";
import { buildAbsentConfirmCustomId } from "../../../src/discord/shared/customId.js";
import { callArg } from "../../helpers/assertions.js";
import { asInteraction, buildButtonInteraction } from "../../helpers/interaction.js";
import { asDiscordClient } from "../../helpers/discord.js";
import { buildSessionRow } from "../factories/session.js";
import { createTestAppContext, type TestAppContext } from "../../testing/index.js";

const seededMembers = appConfig.memberUserIds.map((userId, index) => ({
  id: `member-${index}`,
  userId,
  displayName: `Member ${index + 1}`
}));

const testSessionId = "4f7d54aa-3898-4a13-9f7c-5872a8220e0f";

const confirmCustomId = buildAbsentConfirmCustomId({
  kind: "ask_absent",
  sessionId: testSessionId,
  choice: "confirm"
});

const abortCustomId = buildAbsentConfirmCustomId({
  kind: "ask_absent",
  sessionId: testSessionId,
  choice: "abort"
});

const createDiscordClient = () => {
  const askEdit = vi.fn(async () => undefined);
  const channelSend = vi.fn(async () => ({ id: "notice-1" }));
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: channelSend,
    messages: {
      fetch: vi.fn(async () => ({ edit: askEdit }))
    }
  };

  const client = asDiscordClient({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  });

  return { client, askEdit, channelSend };
};

const buildDeps = (
  client: ReturnType<typeof createDiscordClient>["client"],
  context: TestAppContext
): InteractionHandlerDeps => ({
  sendAsk: vi.fn(async () => ({ status: "sent" as const, weekKey: "2026-W17" })),
  client,
  context
});

const editReplyPayload = (interaction: { readonly editReply: ReturnType<typeof vi.fn> }) =>
  callArg<{ readonly content: string; readonly components?: readonly unknown[] }>(
    interaction.editReply
  );

describe("ask_absent confirmation button — abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("abort: no state changes and ephemeral updated to aborted message", async () => {
    const session = buildSessionRow({ id: testSessionId, askMessageId: "ask-msg-1" });
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client } = createDiscordClient();
    const interaction = buildButtonInteraction(abortCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    // invariant: abort は response を記録しない。
    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(0);
    expect(editReplyPayload(interaction)).toStrictEqual({
      content: askMessages.absentConfirm.aborted,
      components: []
    });
  });
});

describe("ask_absent confirmation button — confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirm: records ABSENT, cancels session, and confirms with editReply", async () => {
    // why: postponeCount: 1 (土曜) で順延不可とし、ABSENT 後に CANCELLED 確定で止まることを検証する。
    const session = buildSessionRow({ id: testSessionId, askMessageId: "ask-msg-1", postponeCount: 1 });
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client, askEdit } = createDiscordClient();
    const interaction = buildButtonInteraction(confirmCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    // invariant: ABSENT が記録され、セッションが CANCELLED に遷移する。
    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.choice).toBe("ABSENT");

    // invariant: 欠席が記録されセッションは ASKING から脱出する（土曜回なので COMPLETED に収束）。
    const updated = await ctx.ports.sessions.findSessionById(testSessionId);
    expect(updated?.status).not.toBe("ASKING");

    // invariant: 募集メッセージが更新される。
    expect(askEdit).toHaveBeenCalledOnce();

    expect(editReplyPayload(interaction)).toStrictEqual({
      content: askMessages.absentConfirm.confirmed,
      components: []
    });
  });

  it("confirm: session deadline already passed → guard rejects with ephemeral", async () => {
    const session = buildSessionRow({ id: testSessionId, askMessageId: "ask-msg-1" });
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T14:00:00.000Z") // after deadlineAt 12:30Z
    });
    const { client } = createDiscordClient();
    const interaction = buildButtonInteraction(confirmCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(0);
    expect(editReplyPayload(interaction).components).toStrictEqual([]);
    expect(typeof editReplyPayload(interaction).content).toBe("string");
  });

  it("confirm: session not in ASKING state → guard rejects with ephemeral", async () => {
    const session = buildSessionRow({
      id: testSessionId,
      status: "CANCELLED",
      cancelReason: "all_absent",
      askMessageId: "ask-msg-1"
    });
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client } = createDiscordClient();
    const interaction = buildButtonInteraction(confirmCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    const after = await ctx.ports.sessions.findSessionById(testSessionId);
    expect(after?.status).toBe("CANCELLED"); // unchanged
    expect(editReplyPayload(interaction).components).toStrictEqual([]);
  });

  it("confirm: non-member user → dispatcher cheapFirstGuard rejects with followUp", async () => {
    const session = buildSessionRow({ id: testSessionId, askMessageId: "ask-msg-1" });
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-24T10:00:00.000Z")
    });
    const { client } = createDiscordClient();
    const interaction = buildButtonInteraction(confirmCustomId, {
      user: { id: "non-member-user-999" }
    });

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(0);
    // invariant: non-member は dispatcher の cheapFirstGuard で弾かれ followUp で通知される。
    //   deferUpdate 後の followUp で ephemeral 拒否。editReply は呼ばれない。
    expect(interaction.followUp).toHaveBeenCalledOnce();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });
});
