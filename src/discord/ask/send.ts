import { randomUUID } from "node:crypto";

import { ChannelType, type Client } from "discord.js";

import { db as defaultDb } from "../../db/client.js";
import {
  createAskSession,
  findSessionByWeekKeyAndPostponeCount,
  listMembers,
  updateAskMessageId
} from "../../db/repositories/index.js";
import type { DbLike } from "../../db/types.js";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { isShuttingDown } from "../../shutdown.js";
import {
  candidateDateForAsk,
  deadlineFor,
  formatCandidateDateIso,
  isoWeekKey,
  systemClock,
  type Clock
} from "../../time/index.js";
import { renderAskBody } from "./render.js";
import { buildInitialAskMessageViewModel } from "../viewModels.js";

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

// single-instance: プロセス内 in-flight マップ。Fly app を 2 インスタンス以上にスケールすると
//   このロックは効かず、DB の sessions_week_key_postpone_count_unique 制約が最終防衛線になる。
// race: 同一 weekKey に対する cron tick と /ask 手動実行の並走を 1 本化する (重複 Discord 投稿の抑制)。
// idempotent: ロック外側でも findSessionByWeekKeyAndPostponeCount による既存検出と unique 制約で重複は防がれる。
//   このマップは「Discord API 呼び出し前の無駄な往復」を省く最適化の役割。
// @see docs/adr/0001-single-instance-db-as-source-of-truth.md
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
  const candidateDate = candidateDateForAsk(now);
  const candidateIso = formatCandidateDateIso(candidateDate);
  const deadline = deadlineFor(candidateDate);

  const existing = await findSessionByWeekKeyAndPostponeCount(db, weekKey, 0);
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
  const created = await createAskSession(db, {
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
    const raced = await findSessionByWeekKeyAndPostponeCount(db, weekKey, 0);
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

  const memberRows = await listMembers(db);
  // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
  const vm = buildInitialAskMessageViewModel(created.id, candidateDate, memberRows);
  const sentMessage = await channel.send(renderAskBody(vm));
  await updateAskMessageId(db, created.id, sentMessage.id);

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
 * @param client - Logged-in Discord client.
 * @param context - Trigger metadata and optional DB/clock overrides for tests.
 * @returns
 *   - `{ status: "sent" }` when a new session was created and a Discord message was posted.
 *   - `{ status: "skipped" }` when another path (cron / /ask) already handled the same week.
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
