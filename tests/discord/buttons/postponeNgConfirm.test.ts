import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleInteraction } from "../../../src/discord/shared/dispatcher.js";
import type { InteractionHandlerDeps } from "../../../src/discord/shared/dispatcher.js";
import type { ResponseRow, SessionRow } from "../../../src/db/rows.js";
import { appConfig } from "../../../src/userConfig.js";
import { postponeMessages } from "../../../src/features/postpone-voting/messages.js";
import { buildPostponeNgConfirmCustomId } from "../../../src/discord/shared/customId.js";
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

const postponeSession = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({
    id: testSessionId,
    status: "POSTPONE_VOTING",
    postponeCount: 0,
    postponeMessageId: "postpone-msg-1",
    deadlineAt: new Date("2026-04-25T15:00:00.000Z"),
    ...overrides
  });

const postponeResponse = (
  index: number,
  choice: "POSTPONE_OK" | "POSTPONE_NG"
): ResponseRow => ({
  id: `response-${index}`,
  sessionId: testSessionId,
  memberId: seededMembers[index]!.id,
  choice,
  answeredAt: new Date(`2026-04-25T12:${String(index).padStart(2, "0")}:00.000Z`)
});

const confirmCustomId = buildPostponeNgConfirmCustomId({
  kind: "postpone_ng",
  sessionId: testSessionId,
  choice: "confirm"
});

const abortCustomId = buildPostponeNgConfirmCustomId({
  kind: "postpone_ng",
  sessionId: testSessionId,
  choice: "abort"
});

const createDiscordClient = () => {
  const postponeMessageEdit = vi.fn(async () => undefined);
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: vi.fn(async () => ({ id: "sent-1" })),
    messages: {
      fetch: vi.fn(async () => ({ edit: postponeMessageEdit }))
    }
  };

  const client = asDiscordClient({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  });

  return { client, postponeMessageEdit };
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

describe("postpone_ng confirmation button — abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("abort: no state changes and ephemeral updated to aborted message", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-25T12:00:00.000Z")
    });
    const interaction = buildButtonInteraction(abortCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    // invariant: abort は response を記録しない。
    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(0);
    expect(editReplyPayload(interaction)).toStrictEqual({
      content: postponeMessages.ngConfirm.aborted,
      components: []
    });
  });
});

describe("postpone_ng confirmation button — confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirm: records POSTPONE_NG, settles session, and confirms with editReply", async () => {
    const session = postponeSession();
    const { client, postponeMessageEdit } = createDiscordClient();
    const ctx = createTestAppContext({
      seed: {
        sessions: [session],
        members: seededMembers,
        responses: [
          postponeResponse(1, "POSTPONE_OK"),
          postponeResponse(2, "POSTPONE_OK"),
          postponeResponse(3, "POSTPONE_OK")
        ]
      },
      now: new Date("2026-04-25T12:00:00.000Z")
    });
    const interaction = buildButtonInteraction(confirmCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    // invariant: POSTPONE_NG が記録される。
    const responses = await ctx.ports.responses.listResponses(testSessionId);
    const ngResponses = responses.filter((r) => r.choice === "POSTPONE_NG");
    expect(ngResponses).toHaveLength(1);

    // invariant: NG があればセッションは POSTPONE_VOTING から脱出する。
    // regression: 順延 NG は CANCELLED を経由せず最終的に COMPLETED へ収束する。
    const updated = await ctx.ports.sessions.findSessionById(testSessionId);
    expect(updated?.status).toBe("COMPLETED");
    expect(updated?.cancelReason).toBe("postpone_ng");

    // invariant: 順延メッセージが決着内容で更新される（settlePostponeVotingSession 経由）。
    expect(postponeMessageEdit).toHaveBeenCalledOnce();

    expect(editReplyPayload(interaction)).toStrictEqual({
      content: postponeMessages.ngConfirm.confirmed,
      components: []
    });
  });

  it("confirm: updates an existing OK vote to NG via upsert", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const ctx = createTestAppContext({
      seed: {
        sessions: [session],
        members: seededMembers,
        responses: [postponeResponse(0, "POSTPONE_OK")]
      },
      now: new Date("2026-04-25T12:00:00.000Z")
    });
    const interaction = buildButtonInteraction(confirmCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    const memberResponses = (await ctx.ports.responses.listResponses(testSessionId)).filter(
      (r) => r.memberId === seededMembers[0]!.id
    );
    expect(memberResponses).toHaveLength(1);
    expect(memberResponses[0]?.choice).toBe("POSTPONE_NG");
  });

  it("confirm: session deadline already passed → guard rejects with ephemeral", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-25T16:00:00.000Z") // after deadlineAt 15:00Z
    });
    const interaction = buildButtonInteraction(confirmCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    const responses = await ctx.ports.responses.listResponses(testSessionId);
    expect(responses).toHaveLength(0);
    expect(editReplyPayload(interaction).components).toStrictEqual([]);
    expect(typeof editReplyPayload(interaction).content).toBe("string");
  });

  it("confirm: session not in POSTPONE_VOTING state → guard rejects with ephemeral", async () => {
    const session = postponeSession({ status: "COMPLETED", cancelReason: "postpone_ng" });
    const { client } = createDiscordClient();
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-25T12:00:00.000Z")
    });
    const interaction = buildButtonInteraction(confirmCustomId);

    await handleInteraction(asInteraction(interaction), buildDeps(client, ctx));

    const after = await ctx.ports.sessions.findSessionById(testSessionId);
    expect(after?.status).toBe("COMPLETED"); // unchanged
    expect(editReplyPayload(interaction).components).toStrictEqual([]);
  });

  it("confirm: non-member user → dispatcher cheapFirstGuard rejects with followUp", async () => {
    const session = postponeSession();
    const { client } = createDiscordClient();
    const ctx = createTestAppContext({
      seed: { sessions: [session], members: seededMembers },
      now: new Date("2026-04-25T12:00:00.000Z")
    });
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
