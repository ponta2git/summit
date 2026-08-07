import type { AppContext } from "../appContext.js";
import { ASK_DEADLINE_HHMM, ASK_START_HHMM } from "../config.js";
import { AppError, DatabaseError, ShutdownError } from "../errors/index.js";
import { fromAppCall, fromDatabaseCall } from "../errors/result.js";
import { sendAskMessage } from "../features/ask-session/send.js";
import { logger } from "../logger.js";
import { isoWeekKey } from "../time/index.js";
import { okAsync } from "neverthrow";
import type { SchedulerResult } from "./scheduler.types.js";

const FRIDAY_JS_DAY = 5;

// jst: Date#getDay/getHours は process.env.TZ=Asia/Tokyo 前提で JST を返す。
// source-of-truth: 窓境界は src/config.ts の ASK_START_HHMM / ASK_DEADLINE_HHMM。
// @see ADR-0002
const isFridayAskWindow = (now: Date): boolean => {
  if (now.getDay() !== FRIDAY_JS_DAY) {return false;}
  const hour = now.getHours();
  const minute = now.getMinutes();
  const afterAsk =
    hour > ASK_START_HHMM.hour ||
    (hour === ASK_START_HHMM.hour && minute >= ASK_START_HHMM.minute);
  const beforeDeadline =
    hour < ASK_DEADLINE_HHMM.hour ||
    (hour === ASK_DEADLINE_HHMM.hour && minute < ASK_DEADLINE_HHMM.minute);
  return afterAsk && beforeDeadline;
};

/**
 * Invariant B: Ensure this week's Friday ASKING session exists during the publication window.
 *
 * @remarks
 * 金曜の ASK 窓 (src/config.ts ASK_START_HHMM / ASK_DEADLINE_HHMM) 内で
 * `(weekKey, postponeCount=0)` Session が無い場合のみ通常経路で作成する。窓外では no-op。
 * @see ADR-0051
 */
const mapAskError = (cause: unknown): AppError => {
  if (cause instanceof AppError) {return cause;}
  if (cause instanceof Error && cause.message === "Shutdown in progress.") {
    return new ShutdownError(cause.message, { cause });
  }
  return new DatabaseError("Failed to create missing ASK session.", { cause });
};

export const reconcileMissingAsk = (
  ctx: AppContext
): SchedulerResult<number> => {
  const now = ctx.clock.now();
  if (!isFridayAskWindow(now)) {
    return okAsync(0);
  }

  const weekKey = isoWeekKey(now);
  return fromDatabaseCall(
    () => ctx.ports.sessions.findSessionByWeekKeyAndPostponeCount(weekKey, 0),
    "Failed to check for an existing ASK session."
  ).andThen((existing) => {
    if (existing) {return okAsync(0);}
    return fromAppCall(
      () => sendAskMessage({ trigger: "cron", context: ctx }),
      mapAskError
    ).map((result) => {
      if (result.status === "queued") {
      logger.info(
        {
          event: "reconciler.ask_created",
          sessionId: result.sessionId,
          weekKey: result.weekKey,
          delivery: "outbox"
        },
        "Reconciler: created missing Friday ASKING session."
      );
        return 1;
      }
      return 0;
    });
  });
};
