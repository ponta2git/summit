import { randomUUID } from "node:crypto";

import { ChannelType, type Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import { logger } from "../../logger.js";
import type { SessionRow } from "../../db/ports.js";
import { isShuttingDown } from "../../shutdown.js";
import {
  candidateDateForAsk,
  deadlineFor,
  formatCandidateDateIso,
  isoWeekKey,
  parseCandidateDateIso
} from "../../time/index.js";
import { renderAskBody } from "./render.js";
import { buildInitialAskMessageViewModel } from "./viewModel.js";
import { appConfig } from "../../userConfig.js";

export interface SendAskMessageContext {
  readonly trigger: "cron" | "command";
  readonly invokerId?: string;
  readonly context: AppContext;
}

export interface SendAskMessageResult {
  status: "sent" | "skipped";
  weekKey: string;
  messageId?: string;
  sessionId?: string;
}

// single-instance: プロセス内 in-flight マップ。複数インスタンスでは効かず、DB の
//   `(weekKey, postponeCount)` unique 制約が最終防衛線。
// race: キーは `${weekKey}:${postponeCount}`。金 (0) / 土 (1) は別キーで独立に並走。
// idempotent: ロック外でも `findSessionByWeekKeyAndPostponeCount` + unique で重複は防がれる。
//   このマップは Discord API 呼び出し前の無駄な往復を省く最適化。
// @see ADR-0001
const inFlightSends = new Map<string, Promise<unknown>>();

const withInFlight = <T>(
  key: string,
  start: () => Promise<T>
): { promise: Promise<T>; reused: boolean } => {
  const ongoing = inFlightSends.get(key) as Promise<T> | undefined;
  if (ongoing) {
    return { promise: ongoing, reused: true };
  }
  const current = start();
  inFlightSends.set(key, current);
  const promise = current.finally(() => {
    if (inFlightSends.get(key) === current) {
      inFlightSends.delete(key);
    }
  });
  return { promise, reused: false };
};

const doSendAskMessage = async (
  client: Client,
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  if (isShuttingDown()) {
    throw new Error("Shutdown in progress.");
  }

  const { ports, clock } = context.context;
  const now = clock.now();
  const weekKey = isoWeekKey(now);
  const candidateDate = candidateDateForAsk(now);
  const candidateIso = formatCandidateDateIso(candidateDate);
  const deadline = deadlineFor(candidateDate);

  const existing = await ports.sessions.findSessionByWeekKeyAndPostponeCount(weekKey, 0);
  if (existing) {
    // idempotent: 同一週 Session は 1 件のみ。cron + /ask 二重起動でも skipped を返して副作用を出さない。
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
  const created = await ports.sessions.createAskSession({
    id: sessionId,
    weekKey,
    postponeCount: 0,
    candidateDateIso: candidateIso,
    channelId: appConfig.discord.channelId,
    deadlineAt: deadline
  });

  if (!created) {
    // race: unique 制約で弾かれた。別 tick が先に作成したケース。勝者を再取得して重複送信を回避。
    const raced = await ports.sessions.findSessionByWeekKeyAndPostponeCount(weekKey, 0);
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

  const [channel, memberRows] = await Promise.all([
    client.channels.fetch(appConfig.discord.channelId),
    ports.members.listMembers()
  ]);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }

  const vm = buildInitialAskMessageViewModel(created.id, candidateDate, memberRows);
  const sentMessage = await channel.send(renderAskBody(vm));
  await ports.sessions.updateAskMessageId(created.id, sentMessage.id);

  logger.info(
    {
      sessionId: created.id,
      weekKey,
      messageId: sentMessage.id,
      channelId: appConfig.discord.channelId,
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

/**
 * Sends (or reuses) the weekly ask message for `isoWeekKey(now)` with the initial `postponeCount`.
 *
 * @remarks
 * race / idempotent: in-flight マップ + DB の `(weekKey, postponeCount)` unique 制約の二段構えで
 *   cron × /ask の並走・プロセス内並走・想定外の多重インスタンスでも二重投稿を避ける。
 *   source-of-truth: Discord 投稿失敗時も DB を正本として保持する。
 * @see ADR-0001
 */
export const sendAskMessage = async (
  client: Client,
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  const weekKey = isoWeekKey(context.context.clock.now());
  const { promise, reused } = withInFlight(`${weekKey}:0`, () =>
    doSendAskMessage(client, context)
  );
  const settled = await promise;
  if (!reused) {
    return settled;
  }
  return {
    status: "skipped",
    weekKey: settled.weekKey,
    ...(settled.sessionId ? { sessionId: settled.sessionId } : {}),
    ...(settled.messageId ? { messageId: settled.messageId } : {})
  };
};

const doSendPostponedAskMessage = async (
  client: Client,
  ctx: AppContext,
  saturdaySession: SessionRow
): Promise<void> => {
  if (isShuttingDown()) {
    throw new Error("Shutdown in progress.");
  }

  // idempotent: askMessageId が既に設定済みなら再送しない（再起動後 / 重複 tick 吸収）。
  if (saturdaySession.askMessageId) {
    logger.info(
      {
        sessionId: saturdaySession.id,
        weekKey: saturdaySession.weekKey,
        messageId: saturdaySession.askMessageId,
        postponeCount: saturdaySession.postponeCount
      },
      "Postponed ask message already sent; skipping."
    );
    return;
  }

  const [channel, memberRows] = await Promise.all([
    client.channels.fetch(appConfig.discord.channelId),
    ctx.ports.members.listMembers()
  ]);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }

  const candidateDate = parseCandidateDateIso(saturdaySession.candidateDateIso);
  const vm = buildInitialAskMessageViewModel(saturdaySession.id, candidateDate, memberRows);
  const sentMessage = await channel.send(renderAskBody(vm));
  await ctx.ports.sessions.updateAskMessageId(saturdaySession.id, sentMessage.id);

  logger.info(
    {
      sessionId: saturdaySession.id,
      weekKey: saturdaySession.weekKey,
      messageId: sentMessage.id,
      channelId: appConfig.discord.channelId,
      postponeCount: saturdaySession.postponeCount
    },
    "Postponed ask message sent."
  );
};

/**
 * Sends the Saturday ASKING message for a postponed session.
 *
 * @remarks
 * idempotent: 土曜 Session は `settlePostponeVotingSession` が既に作成済み。本関数は Discord 投稿と
 *   `askMessageId` 保存のみ。`askMessageId` 設定済みなら no-op。
 * race: in-flight キーは金曜送信と別なので同一 weekKey 内でも並走する。
 */
export const sendPostponedAskMessage = async (
  client: Client,
  ctx: AppContext,
  saturdaySession: SessionRow
): Promise<void> => {
  // invariant: `settlePostponeVotingSession` が作成した順延 Session のみを受け取る。
  if (saturdaySession.postponeCount !== 1) {
    throw new Error(
      `sendPostponedAskMessage: expected postponeCount=1, got ${saturdaySession.postponeCount}`
    );
  }

  const { weekKey, postponeCount } = saturdaySession;
  const { promise } = withInFlight(`${weekKey}:${postponeCount}`, () =>
    doSendPostponedAskMessage(client, ctx, saturdaySession)
  );
  await promise;
};

export const waitForInFlightSend = async (): Promise<void> => {
  const inflight = [...inFlightSends.values()];
  if (inflight.length === 0) {return;}
  await Promise.allSettled(inflight);
};

export const __resetSendStateForTest = (): void => {
  inFlightSends.clear();
};
