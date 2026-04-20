import { randomUUID } from "node:crypto";

import { ChannelType, type Client } from "discord.js";

import type { AppContext } from "../../composition.js";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import type { SessionRow } from "../../ports/index.js";
import { isShuttingDown } from "../../shutdown.js";
import {
  candidateDateForAsk,
  deadlineFor,
  formatCandidateDateIso,
  isoWeekKey,
  parseCandidateDateIso
} from "../../time/index.js";
import { renderAskBody } from "./render.js";
import { buildInitialAskMessageViewModel } from "../../discord/shared/viewModels.js";

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

// single-instance: プロセス内 in-flight マップ。Fly app を 2 インスタンス以上にスケールすると
//   このロックは効かず、DB の sessions_week_key_postpone_count_unique 制約が最終防衛線になる。
// race: キーは `${weekKey}:${postponeCount}` 形式。Friday (postponeCount=0) と Saturday (postponeCount=1) は
//   別キーになるため、同一 weekKey 内でも互いをブロックせず独立して並走できる。
// idempotent: ロック外側でも findSessionByWeekKeyAndPostponeCount による既存検出と unique 制約で重複は防がれる。
//   このマップは「Discord API 呼び出し前の無駄な往復」を省く最適化の役割。
// @see docs/adr/0001-single-instance-db-as-source-of-truth.md
const inFlightSends = new Map<string, Promise<unknown>>();

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
    // idempotent: 同一週 (postponeCount=0) は 1 Session のみ。cron + /ask の二重起動でも skipped を返して副作用を出さない。
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
    channelId: env.DISCORD_CHANNEL_ID,
    deadlineAt: deadline
  });

  if (!created) {
    // race: unique 制約で弾かれた。別プロセス / 別 tick が先に作成したケース。
    //   DB 再取得で勝者の Session を返し、呼び出し側は重複送信を回避する。
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

  const channel = await client.channels.fetch(env.DISCORD_CHANNEL_ID);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }

  const memberRows = await ports.members.listMembers();
  // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
  const vm = buildInitialAskMessageViewModel(created.id, candidateDate, memberRows);
  const sentMessage = await channel.send(renderAskBody(vm));
  await ports.sessions.updateAskMessageId(created.id, sentMessage.id);

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

/**
 * Sends (or reuses) the weekly /ask message for `isoWeekKey(now)` with `postponeCount=0`.
 *
 * @remarks
 * cron と /ask の同時起動、プロセス内並走、複数インスタンス (想定外) いずれでも
 * 二重投稿を避けるため、in-flight マップ + DB の `(weekKey, postponeCount)` unique 制約の
 * 二段構えで守る。Discord 投稿失敗時も DB は正本として保持される。
 */
export const sendAskMessage = async (
  client: Client,
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  const weekKey = isoWeekKey(context.context.clock.now());
  // race: mapKey は ${weekKey}:0。土曜送信の ${weekKey}:1 とは別キーなので並走可能。
  const mapKey = `${weekKey}:0`;
  const ongoing = inFlightSends.get(mapKey);
  if (ongoing) {
    // why: `:0` サフィックスにより mapKey は Friday 専用。
    //   このエントリは必ず doSendAskMessage が返す Promise<SendAskMessageResult>。
    const settled = await (ongoing as Promise<SendAskMessageResult>);
    return {
      status: "skipped",
      weekKey: settled.weekKey,
      ...(settled.sessionId ? { sessionId: settled.sessionId } : {}),
      ...(settled.messageId ? { messageId: settled.messageId } : {})
    };
  }

  const current = doSendAskMessage(client, context);
  inFlightSends.set(mapKey, current);
  try {
    return await current;
  } finally {
    if (inFlightSends.get(mapKey) === current) {
      inFlightSends.delete(mapKey);
    }
  }
};

const doSendPostponedAskMessage = async (
  client: Client,
  ctx: AppContext,
  saturdaySession: SessionRow
): Promise<void> => {
  if (isShuttingDown()) {
    throw new Error("Shutdown in progress.");
  }

  // idempotent: askMessageId が既に設定済みなら再送しない (再起動後 / 重複 tick での再入を吸収)。
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

  const channel = await client.channels.fetch(env.DISCORD_CHANNEL_ID);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }

  const memberRows = await ctx.ports.members.listMembers();
  const candidateDate = parseCandidateDateIso(saturdaySession.candidateDateIso);
  // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
  const vm = buildInitialAskMessageViewModel(saturdaySession.id, candidateDate, memberRows);
  const sentMessage = await channel.send(renderAskBody(vm));
  await ctx.ports.sessions.updateAskMessageId(saturdaySession.id, sentMessage.id);

  logger.info(
    {
      sessionId: saturdaySession.id,
      weekKey: saturdaySession.weekKey,
      messageId: sentMessage.id,
      channelId: env.DISCORD_CHANNEL_ID,
      postponeCount: saturdaySession.postponeCount
    },
    "Postponed ask message sent."
  );
};

/**
 * Sends the Saturday ASKING message for a postponed session (`postponeCount=1`).
 *
 * @remarks
 * 土曜 Session は Phase D の `settlePostponeVotingSession` が既に DB に作成済み。
 * 本関数はその行を受け取り Discord メッセージを投稿し `askMessageId` を保存する。
 * `askMessageId` が既に設定済みなら何もしない (冪等)。
 *
 * in-flight マップのキーは `${weekKey}:1`。金曜送信の `${weekKey}:0` とは別キーなので、
 * 同一 weekKey 内で並走可能 (互いをブロックしない)。
 */
export const sendPostponedAskMessage = async (
  client: Client,
  ctx: AppContext,
  saturdaySession: SessionRow
): Promise<void> => {
  // invariant: settlePostponeVotingSession (Phase D) が作成した postponeCount=1 の行のみを受け取る。
  if (saturdaySession.postponeCount !== 1) {
    throw new Error(
      `sendPostponedAskMessage: expected postponeCount=1, got ${saturdaySession.postponeCount}`
    );
  }

  const { weekKey, postponeCount } = saturdaySession;
  // race: mapKey は ${weekKey}:1。金曜送信の ${weekKey}:0 とは別キーなので並走可能。
  const mapKey = `${weekKey}:${postponeCount}`;
  const ongoing = inFlightSends.get(mapKey);
  if (ongoing) {
    await ongoing;
    return;
  }

  const current = doSendPostponedAskMessage(client, ctx, saturdaySession);
  inFlightSends.set(mapKey, current);
  try {
    await current;
  } finally {
    if (inFlightSends.get(mapKey) === current) {
      inFlightSends.delete(mapKey);
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
