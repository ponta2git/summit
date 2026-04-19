import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type MessageCreateOptions
} from "discord.js";

import { env } from "../env.js";
import { logger } from "../logger.js";
import { buildMemberLines } from "../members.js";
import { isShuttingDown } from "../shutdown.js";
import { candidateDateForSend, formatCandidateJa, isoWeekKey, systemClock, type Clock } from "../time/index.js";

const ASK_CHOICES = ["t2200", "t2230", "t2300", "t2330", "absent"] as const;
type AskChoice = (typeof ASK_CHOICES)[number];

const ASK_BUTTON_LABELS: Record<AskChoice, string> = {
  t2200: "22:00",
  t2230: "22:30",
  t2300: "23:00",
  t2330: "23:30",
  absent: "欠席"
};

let lastSentWeekKey: string | undefined;
let inFlightSend: Promise<SendAskMessageResult> | undefined;

export interface SendAskMessageContext {
  trigger: "cron" | "command";
  invokerId?: string;
  clock?: Clock;
}

export interface SendAskMessageResult {
  status: "sent" | "skipped";
  weekKey: string;
  messageId?: string;
}

export const buildAskRow = (sessionId: string): ActionRowBuilder<ButtonBuilder> => {
  const buttons = ASK_CHOICES.map((choice) =>
    new ButtonBuilder()
      .setCustomId(`ask:${sessionId}:${choice}`)
      .setLabel(ASK_BUTTON_LABELS[choice])
      .setStyle(choice === "absent" ? ButtonStyle.Danger : ButtonStyle.Secondary)
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
};

const buildAskContent = (candidateDate: Date, memberUserIds: readonly string[]): string => {
  const mentions = memberUserIds.map((userId) => `<@${userId}>`).join(" ");
  const statusLines = buildMemberLines(memberUserIds)
    .map((member) => `- ${member.displayName} : 未回答`)
    .join("\n");

  return [
    mentions,
    "🎲 今週の桃鉄1年勝負の出欠確認です",
    "",
    `開催候補日: ${formatCandidateJa(candidateDate)}`,
    "回答締切: 21:30（未回答者が残っていれば中止）",
    "ルール: 「欠席」が1人でも出た時点で中止 / 押した時刻 \"以降\" なら参加OK",
    "      （例: 23:00 を押すと 23:00/23:30 でも参加可能として集計されます）",
    "",
    "【回答状況】",
    statusLines
  ].join("\n");
};

export const renderAskBody = (sessionId: string, candidateDate: Date): MessageCreateOptions => ({
  content: buildAskContent(candidateDate, env.MEMBER_USER_IDS),
  components: [buildAskRow(sessionId)]
});

const doSendAskMessage = async (
  client: Client,
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  if (isShuttingDown()) {
    throw new Error("Shutdown in progress.");
  }

  const clock = context.clock ?? systemClock;
  const now = clock.now();
  const weekKey = isoWeekKey(now);

  if (lastSentWeekKey === weekKey) {
    logger.warn(
      {
        weekKey,
        trigger: context.trigger,
        invokerId: context.invokerId
      },
      "Duplicate ask message skipped."
    );
    return { status: "skipped", weekKey };
  }

  const channel = await client.channels.fetch(env.DISCORD_CHANNEL_ID);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }

  const sessionId = randomUUID();
  const candidateDate = candidateDateForSend(now);
  const sentMessage = await channel.send(renderAskBody(sessionId, candidateDate));
  lastSentWeekKey = weekKey;

  logger.info(
    {
      sessionId,
      weekKey,
      messageId: sentMessage.id,
      channelId: env.DISCORD_CHANNEL_ID,
      trigger: context.trigger,
      userId: context.invokerId
    },
    "Ask message sent."
  );

  return {
    status: "sent",
    weekKey,
    messageId: sentMessage.id
  };
};

export const sendAskMessage = async (
  client: Client,
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  const ongoing = inFlightSend;
  if (ongoing) {
    const settled = await ongoing;
    return {
      status: "skipped",
      weekKey: settled.weekKey
    };
  }

  const current = doSendAskMessage(client, context);
  inFlightSend = current;
  try {
    return await current;
  } finally {
    if (inFlightSend === current) {
      inFlightSend = undefined;
    }
  }
};

export const waitForInFlightSend = async (): Promise<void> => {
  const current = inFlightSend;
  if (!current) {
    return;
  }
  await current;
};

export const __resetSendStateForTest = (): void => {
  lastSentWeekKey = undefined;
  inFlightSend = undefined;
};
