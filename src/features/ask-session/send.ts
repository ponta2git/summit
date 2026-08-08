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
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  if (isShuttingDown()) {
    throw new ShutdownError("Shutdown in progress.");
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
 * @see ADR-0001
 */
export const sendAskMessage = async (
  context: SendAskMessageContext
): Promise<SendAskMessageResult> => {
  const weekKey = isoWeekKey(context.context.clock.now());
  const { promise, reused } = withInFlight(`${weekKey}:0`, () =>
    doSendAskMessage(context)
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
  const inflight = [...inFlightSends.values()];
  if (inflight.length === 0) {return;}
  await Promise.allSettled(inflight);
};

export const resetSendStateForTest = (): void => {
  inFlightSends.clear();
};
