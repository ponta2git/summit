import {
  type Client,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
  type ButtonInteraction
} from "discord.js";
import { z } from "zod";

import { db as defaultDb } from "../db/client.js";
import {
  findMemberIdByUserId,
  findSessionById,
  listMembers,
  listResponses,
  upsertResponse,
  type DbLike
} from "../db/repositories/sessions.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import {
  decidedStartAt,
  parseCandidateDateIso,
  systemClock,
  type AskTimeChoice,
  type Clock
} from "../time/index.js";
import {
  buildAskRenderFromDb,
  sendAskMessage,
  type SendAskMessageContext,
  type SendAskMessageResult
} from "./askMessage.js";
import { settleAskingSession, tryDecideIfAllTimeSlots } from "./settle.js";
import { randomUUID } from "node:crypto";

// invariant: Discord button custom_id (小文字) → DB enum (大文字) の 1:1 変換。
//   askMessage.ts の ASK_CHOICES / askCustomIdSchema と同期必須。new choice 追加時は 3 箇所同時更新。
const ASK_CHOICE_MAP: Record<string, "T2200" | "T2230" | "T2300" | "T2330" | "ABSENT"> = {
  t2200: "T2200",
  t2230: "T2230",
  t2300: "T2300",
  t2330: "T2330",
  absent: "ABSENT"
};

// invariant: custom_id 形式は `ask:{UUIDv4}:{choice}`。
//   送信側 (buildAskRow) が生成する形式と一致させる。UUID 以外 / 未知 choice は cheap-reject する。
const askCustomIdSchema = z
  .string()
  .regex(
    /^ask:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(t2200|t2230|t2300|t2330|absent)$/
  );

// invariant: 順延投票 custom_id は `postpone:{UUIDv4}:{ok|ng}`。
const postponeCustomIdSchema = z
  .string()
  .regex(
    /^postpone:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(ok|ng)$/
  );

type SendAsk = (context: SendAskMessageContext) => Promise<SendAskMessageResult>;

export interface InteractionHandlerDeps {
  sendAsk: SendAsk;
  client: Client;
  db?: DbLike;
  clock?: Clock;
}

// invariant: Guild / Channel / Member の 3 点ガード。
//   cheap-first 検証 (network I/O なし) で対象外の interaction を DB 読み出し前に弾く。
// @see docs/adr/0004-discord-interaction-architecture.md
const isAllowedActor = (
  guildId: string | null,
  channelId: string,
  userId: string
): boolean =>
  guildId === env.DISCORD_GUILD_ID &&
  channelId === env.DISCORD_CHANNEL_ID &&
  env.MEMBER_USER_IDS.includes(userId);

const rejectMessage = "対象外です";

const handleAskCommand = async (
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  // ack: Slash command は 3 秒以内に defer/reply しないと失敗する。ephemeral で個人宛に即 ack。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!isAllowedActor(interaction.guildId, interaction.channelId, interaction.user.id)) {
    await interaction.editReply(rejectMessage);
    return;
  }

  try {
    const result = await deps.sendAsk({
      trigger: "command",
      invokerId: interaction.user.id
    });

    if (result.status === "sent") {
      await interaction.editReply("送信しました");
      return;
    }

    await interaction.editReply("本週は既に送信済みのためスキップしました");
  } catch (error: unknown) {
    logger.error(
      {
        error,
        interactionId: interaction.id,
        userId: interaction.user.id
      },
      "Failed to execute /ask."
    );
    await interaction.editReply("送信に失敗しました");
  }
};

const handleCancelWeekCommand = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  if (!isAllowedActor(interaction.guildId, interaction.channelId, interaction.user.id)) {
    await interaction.reply({
      content: rejectMessage,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    content: "未実装です（将来 PR で実装予定）",
    flags: MessageFlags.Ephemeral
  });
};

const handleAskButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  const db = deps.db ?? defaultDb;
  const clock = deps.clock ?? systemClock;

  const parsed = askCustomIdSchema.safeParse(interaction.customId);
  if (!parsed.success) {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "Invalid custom_id for ask button."
    );
    await interaction.followUp({
      content: "未知の操作です",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const [, sessionId, lowerChoice] = parsed.data.split(":");
  if (!sessionId || !lowerChoice) {return;}
  const choice = ASK_CHOICE_MAP[lowerChoice];
  if (!choice) {return;}

  const session = await findSessionById(db, sessionId);
  if (!session) {
    await interaction.followUp({
      content: "セッションが見つかりません",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (session.status !== "ASKING") {
    await interaction.followUp({
      content: "この募集は既に締め切られています",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const memberId = await findMemberIdByUserId(db, interaction.user.id);
  if (!memberId) {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "User is allowed but no matching member row."
    );
    await interaction.followUp({
      content: "メンバー登録がありません",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await upsertResponse(db, {
    id: randomUUID(),
    sessionId,
    memberId,
    choice,
    answeredAt: clock.now()
  });

  logger.info(
    {
      sessionId,
      weekKey: session.weekKey,
      userId: interaction.user.id,
      memberId,
      choice
    },
    "Ask response recorded."
  );

  if (choice === "ABSENT") {
    await settleAskingSession(deps.client, db, sessionId, "absent");
    return;
  }

  const responses = await listResponses(db, sessionId);
  const memberRows = await listMembers(db);
  const memberLookup = new Map(memberRows.map((m) => [m.id, m.userId]));

  const allTimeChoices = responses.every(
    (r) => r.choice === "T2200" || r.choice === "T2230" || r.choice === "T2300" || r.choice === "T2330"
  );
  const activeMembers = memberRows.filter((m) => env.MEMBER_USER_IDS.includes(m.userId));
  const allAnswered = responses.length === activeMembers.length;

  if (allAnswered && allTimeChoices) {
    const timeChoices = responses
      .map((r) => r.choice)
      .filter((c): c is AskTimeChoice => c !== "ABSENT" && c !== "POSTPONE_OK" && c !== "POSTPONE_NG");
    const start = decidedStartAt(parseCandidateDateIso(session.candidateDate), timeChoices);
    if (start) {
      await tryDecideIfAllTimeSlots(db, session, start);
    }
  }

  const fresh = await findSessionById(db, sessionId);
  if (!fresh || !fresh.askMessageId) {return;}

  // source-of-truth: メッセージ再描画は常に DB から再構築する。interaction.message の内容を
  //   編集ベースに使うと、同時押下時に古い回答状況で上書きしてしまう。
  try {
    const rendered = await buildAskRenderFromDb(db, fresh, memberLookup);
    await interaction.message.edit(rendered);
  } catch (error: unknown) {
    // race: edit 失敗は DB 状態を巻き戻さない。次 tick / 次押下で再描画される。
    logger.warn(
      { error, sessionId, messageId: fresh.askMessageId },
      "Failed to edit ask message after response."
    );
  }
};

const handlePostponeButton = async (interaction: ButtonInteraction): Promise<void> => {
  const parsed = postponeCustomIdSchema.safeParse(interaction.customId);
  if (!parsed.success) {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "Invalid custom_id for postpone button."
    );
    await interaction.followUp({
      content: "未知の操作です",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.followUp({
    content: "順延投票は受付準備中です。近日公開予定です。",
    flags: MessageFlags.Ephemeral
  });
};

const handleButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  // ack: Component interaction は 3 秒以内の deferUpdate が必須。検証・DB アクセスより先に ack する。
  //   deferUpdate 後はメッセージ編集で応答し、失敗時は ephemeral followUp で却下メッセージを返す。
  await interaction.deferUpdate();

  if (!isAllowedActor(interaction.guildId, interaction.channelId, interaction.user.id)) {
    await interaction.followUp({
      content: "このボタンは対象外です",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId.startsWith("ask:")) {
    await handleAskButton(interaction, deps);
    return;
  }
  if (interaction.customId.startsWith("postpone:")) {
    await handlePostponeButton(interaction);
    return;
  }

  logger.warn(
    { interactionId: interaction.id, customId: interaction.customId },
    "Unknown button custom_id prefix."
  );
};

/**
 * Dispatches a Discord interaction to the appropriate handler (slash command / button).
 *
 * @remarks
 * 入口で即 ack (3 秒制約) し、検証順は guildId → channelId → user → custom_id → DB 状態。
 * 認可失敗は ephemeral で却下し、DB 状態を一切変更しない。再描画は DB の Session + Response
 * から組み立て直す。
 *
 * @see docs/adr/0004-discord-interaction-architecture.md
 */
export const handleInteraction = async (
  interaction: Interaction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "ask") {
      await handleAskCommand(interaction, deps);
      return;
    }

    if (interaction.commandName === "cancel_week") {
      await handleCancelWeekCommand(interaction);
      return;
    }

    await interaction.reply({
      content: "未対応コマンドです",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.isButton()) {
    await handleButton(interaction, deps);
  }
};

export const registerInteractionHandlers = (client: Client): void => {
  client.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction, {
      client,
      sendAsk: (context) => sendAskMessage(client, context)
    });
  });
};
