import { randomUUID } from "node:crypto";

import type { AppContext } from "../../appContext.ts";
import { ShutdownError } from "../../errors/index.ts";
import { logger } from "../../logger.ts";
import { buildAskBodyIntent } from "../../db/repositories/sessionOutboxIntents.ts";
import { isShuttingDown } from "../../shutdown.ts";
import {
  candidateDateForAsk,
  deadlineFor,
  formatCandidateDateIso,
  isoWeekKey
} from "../../time/index.ts";
import { appConfig } from "../../userConfig.ts";

export interface SendAskMessageContext {
  readonly trigger: "cron" | "command";
  readonly invokerId?: string;
  readonly context: AppContext;
}

export interface SendAskMessageResult {
  status: "queued" | "skipped";
  weekKey: string;
  sessionId?: string;
}

// single-instance: 同じ AppContext / ISO週の初回募集をまとめ、余分な DB 往復を抑える。
//   複数 instance 間の一意性は DB の `(weekKey, postponeCount)` 制約が守る。
//   settlement 後に context ごと削除し、失敗した作成を次の invocation で再試行できる。
const inFlightSends = new Map<AppContext, Map<string, Promise<SendAskMessageResult>>>();

const withInFlight = (
  context: AppContext,
  key: string,
  start: () => Promise<SendAskMessageResult>
): { promise: Promise<SendAskMessageResult>; reused: boolean } => {
  let requests = inFlightSends.get(context);
  if (!requests) {
    requests = new Map();
    inFlightSends.set(context, requests);
  }
  const ongoing = requests.get(key);
  if (ongoing) {
    return { promise: ongoing, reused: true };
  }
  const current = Promise.resolve().then(start);
  requests.set(key, current);
  const promise = current.finally(() => {
    if (requests.get(key) === current) {
      requests.delete(key);
      if (requests.size === 0) { inFlightSends.delete(context); }
    }
  });
  return { promise, reused: false };
};

const doSendAskMessage = async (
  context: SendAskMessageContext,
  now: Date,
  weekKey: string
): Promise<SendAskMessageResult> => {
  if (isShuttingDown()) {
    throw new ShutdownError("Shutdown in progress.");
  }

  const { ports } = context.context;
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
      sessionId: existing.id
    };
  }

  const sessionId = randomUUID();
  const created = await ports.sessions.createAskSession({
    id: sessionId,
    weekKey,
    postponeCount: 0,
    candidateDateIso: candidateIso,
    channelId: appConfig.discord.channelId,
    deadlineAt: deadline,
    outbox: [
      buildAskBodyIntent({
        id: sessionId,
        channelId: appConfig.discord.channelId,
        revision: 0
      })
    ]
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
      ...(raced?.id ? { sessionId: raced.id } : {})
    };
  }

  logger.info(
    {
      sessionId: created.id,
      weekKey,
      channelId: appConfig.discord.channelId,
      trigger: context.trigger,
      userId: context.invokerId
    },
    "Ask message queued."
  );

  return {
    status: "queued",
    weekKey,
    sessionId: created.id
  };
};

/**
 * Creates the weekly ASKING Session and its delivery intent atomically.
 *
 * @remarks
 * race / idempotent: in-flight マップ + DB の `(weekKey, postponeCount)` unique 制約の二段構えで
 *   cron × /ask の並走を吸収する。Session と outbox intent は同一 transaction で作成する。
 */
export const sendAskMessage = async (
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  // iso-week: in-flight key と永続化する候補日/週は、週境界でも同じ snapshot を使う。
  const now = context.context.clock.now();
  const weekKey = isoWeekKey(now);
  const { promise, reused } = withInFlight(context.context, `${weekKey}:0`, () =>
    doSendAskMessage(context, now, weekKey)
  );
  const settled = await promise;
  if (!reused) {
    return settled;
  }
  return {
    status: "skipped",
    weekKey: settled.weekKey,
    ...(settled.sessionId ? { sessionId: settled.sessionId } : {})
  };
};

export const waitForInFlightSend = async (): Promise<void> => {
  const inflight = [...inFlightSends.values()].flatMap(requests => [...requests.values()]);
  if (inflight.length === 0) {return;}
  await Promise.allSettled(inflight);
};

export const resetSendStateForTest = (): void => {
  inFlightSends.clear();
};
