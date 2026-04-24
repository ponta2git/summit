import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import { ASK_DEADLINE_HHMM, ASK_START_HHMM } from "../config.js";
import { sendAskMessage } from "../features/ask-session/send.js";
import { logger } from "../logger.js";
import { isoWeekKey } from "../time/index.js";

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
 * @see ADR-0033
 */
export const reconcileMissingAsk = async (
  client: Client,
  ctx: AppContext
): Promise<number> => {
  const now = ctx.clock.now();
  if (!isFridayAskWindow(now)) {
    return 0;
  }

  const weekKey = isoWeekKey(now);
  const existing = await ctx.ports.sessions.findSessionByWeekKeyAndPostponeCount(weekKey, 0);
  if (existing) {
    return 0;
  }

  try {
    const result = await sendAskMessage(client, { trigger: "cron", context: ctx });
    if (result.status === "sent") {
      logger.info(
        {
          event: "reconciler.ask_created",
          sessionId: result.sessionId,
          weekKey: result.weekKey,
          messageId: result.messageId
        },
        "Reconciler: created missing Friday ASKING session."
      );
      return 1;
    }
    return 0;
  } catch (error: unknown) {
    logger.error(
      { error, event: "reconciler.ask_created_failed", weekKey },
      "Reconciler: failed to create missing Friday ASKING session."
    );
    return 0;
  }
};
