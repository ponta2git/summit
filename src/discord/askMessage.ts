import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";

import { db as defaultDb } from "../db/client.js";
import {
  createAskSession,
  findActiveSessionByWeekKey,
  listResponses,
  setAskMessageId,
  type DbLike,
  type ResponseRow,
  type SessionRow
} from "../db/repositories/sessions.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { buildMemberLines } from "../members.js";
import { isShuttingDown } from "../shutdown.js";
import {
  candidateDateForSend,
  decidedStartAt,
  deadlineFor,
  formatCandidateDateIso,
  formatCandidateJa,
  isoWeekKey,
  parseCandidateDateIso,
  systemClock,
  type AskTimeChoice,
  type Clock
} from "../time/index.js";

const ASK_CHOICES = ["t2200", "t2230", "t2300", "t2330", "absent"] as const;
type AskChoice = (typeof ASK_CHOICES)[number];

const ASK_BUTTON_LABELS: Record<AskChoice, string> = {
  t2200: "22:00",
  t2230: "22:30",
  t2300: "23:00",
  t2330: "23:30",
  absent: "欠席"
};

const CHOICE_LABEL_FOR_RESPONSE: Record<string, string> = {
  T2200: "22:00",
  T2230: "22:30",
  T2300: "23:00",
  T2330: "23:30",
  ABSENT: "欠席"
};

export interface SendAskMessageContext {
  trigger: "cron" | "command";
  invokerId?: string;
  clock?: Clock;
  db?: DbLike;
}

export interface SendAskMessageResult {
  status: "sent" | "skipped";
  weekKey: string;
  messageId?: string;
  sessionId?: string;
}

export const buildAskRow = (
  sessionId: string,
  options: { disabled?: boolean } = {}
): ActionRowBuilder<ButtonBuilder> => {
  const buttons = ASK_CHOICES.map((choice) =>
    new ButtonBuilder()
      .setCustomId(`ask:${sessionId}:${choice}`)
      .setLabel(ASK_BUTTON_LABELS[choice])
      .setStyle(choice === "absent" ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(Boolean(options.disabled))
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
};

const memberLinesFromState = (
  memberUserIds: readonly string[],
  responsesByUserId: ReadonlyMap<string, string>
): string =>
  buildMemberLines(memberUserIds)
    .map((member) => {
      const choice = responsesByUserId.get(member.userId);
      const label = choice ? CHOICE_LABEL_FOR_RESPONSE[choice] ?? choice : "未回答";
      return `- ${member.displayName} : ${label}`;
    })
    .join("\n");

const buildAskContent = (
  candidateDate: Date,
  memberUserIds: readonly string[],
  responsesByUserId: ReadonlyMap<string, string>,
  extraFooter: string | undefined
): string => {
  const mentions = memberUserIds.map((userId) => `<@${userId}>`).join(" ");
  const statusLines = memberLinesFromState(memberUserIds, responsesByUserId);

  const lines = [
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
  ];
  if (extraFooter) {
    lines.push("", extraFooter);
  }
  return lines.join("\n");
};

export interface RenderAskBodyOptions {
  footer?: string;
}

export const renderAskBody = (
  session: Pick<SessionRow, "id" | "candidateDate" | "status">,
  responses: readonly ResponseRow[],
  memberLookup: ReadonlyMap<string, string>,
  options: RenderAskBodyOptions = {}
): MessageCreateOptions & MessageEditOptions => {
  const responsesByUserId = new Map<string, string>();
  for (const response of responses) {
    const userId = memberLookup.get(response.memberId);
    if (userId) {responsesByUserId.set(userId, response.choice);}
  }

  const disabled = session.status !== "ASKING";
  const candidateDate = parseCandidateDateIso(session.candidateDate);

  return {
    content: buildAskContent(
      candidateDate,
      env.MEMBER_USER_IDS,
      responsesByUserId,
      options.footer
    ),
    components: [buildAskRow(session.id, { disabled })]
  };
};

const renderInitialAskBody = (
  sessionId: string,
  candidateDate: Date
): MessageCreateOptions => ({
  content: buildAskContent(candidateDate, env.MEMBER_USER_IDS, new Map(), undefined),
  components: [buildAskRow(sessionId, { disabled: false })]
});

const inFlightSends = new Map<string, Promise<SendAskMessageResult>>();

const doSendAskMessage = async (
  client: Client,
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  if (isShuttingDown()) {
    throw new Error("Shutdown in progress.");
  }

  const db = context.db ?? defaultDb;
  const clock = context.clock ?? systemClock;
  const now = clock.now();
  const weekKey = isoWeekKey(now);
  const candidateDate = candidateDateForSend(now);
  const candidateIso = formatCandidateDateIso(candidateDate);
  const deadline = deadlineFor(candidateDate);

  const existing = await findActiveSessionByWeekKey(db, weekKey, 0);
  if (existing) {
    logger.warn(
      {
        weekKey,
        sessionId: existing.id,
        trigger: context.trigger,
        userId: context.invokerId
      },
      "Duplicate ask message skipped."
    );
    return {
      status: "skipped",
      weekKey,
      sessionId: existing.id,
      ...(existing.askMessageId ? { messageId: existing.askMessageId } : {})
    };
  }

  const sessionId = randomUUID();
  const created = await createAskSession(db, {
    id: sessionId,
    weekKey,
    postponeCount: 0,
    candidateDate: candidateIso,
    channelId: env.DISCORD_CHANNEL_ID,
    deadlineAt: deadline
  });

  if (!created) {
    const raced = await findActiveSessionByWeekKey(db, weekKey, 0);
    logger.warn(
      {
        weekKey,
        sessionId: raced?.id,
        trigger: context.trigger,
        userId: context.invokerId
      },
      "Duplicate ask message skipped (race)."
    );
    return {
      status: "skipped",
      weekKey,
      ...(raced?.id ? { sessionId: raced.id } : {}),
      ...(raced?.askMessageId ? { messageId: raced.askMessageId } : {})
    };
  }

  const channel = await client.channels.fetch(env.DISCORD_CHANNEL_ID);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }

  const sentMessage = await channel.send(renderInitialAskBody(created.id, candidateDate));
  await setAskMessageId(db, created.id, sentMessage.id);

  logger.info(
    {
      sessionId: created.id,
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
    sessionId: created.id,
    messageId: sentMessage.id
  };
};

export const sendAskMessage = async (
  client: Client,
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  const clock = context.clock ?? systemClock;
  const weekKey = isoWeekKey(clock.now());
  const ongoing = inFlightSends.get(weekKey);
  if (ongoing) {
    const settled = await ongoing;
    return {
      status: "skipped",
      weekKey: settled.weekKey,
      ...(settled.sessionId ? { sessionId: settled.sessionId } : {}),
      ...(settled.messageId ? { messageId: settled.messageId } : {})
    };
  }

  const current = doSendAskMessage(client, context);
  inFlightSends.set(weekKey, current);
  try {
    return await current;
  } finally {
    if (inFlightSends.get(weekKey) === current) {
      inFlightSends.delete(weekKey);
    }
  }
};

export const waitForInFlightSend = async (): Promise<void> => {
  const inflight = [...inFlightSends.values()];
  if (inflight.length === 0) {return;}
  await Promise.allSettled(inflight);
};

export const __resetSendStateForTest = (): void => {
  inFlightSends.clear();
};

/**
 * Load session + responses from DB and return a MessageEditOptions that
 * reflects the current state. Used by interaction/cron paths.
 */
export const buildAskRenderFromDb = async (
  db: DbLike,
  session: SessionRow,
  memberLookup: ReadonlyMap<string, string>
): Promise<MessageEditOptions> => {
  const responses = await listResponses(db, session.id);

  let footer: string | undefined;
  if (session.status === "DECIDED" && session.decidedStartAt) {
    const timeChoices = responses
      .map((r) => r.choice)
      .filter((c): c is AskTimeChoice => c === "T2200" || c === "T2230" || c === "T2300" || c === "T2330");
    const start = decidedStartAt(parseCandidateDateIso(session.candidateDate), timeChoices);
    if (start) {
      const hh = String(start.getHours()).padStart(2, "0");
      const mm = String(start.getMinutes()).padStart(2, "0");
      footer = `✅ 全員回答により ${hh}:${mm} 開始で確定（開催決定メッセージは追って送信）`;
    }
  } else if (session.status === "CANCELLED") {
    footer = "🛑 中止。この週の募集は締め切りました";
  }

  return renderAskBody(session, responses, memberLookup, footer ? { footer } : {});
};
