import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import type { AppError } from "../../errors/index.js";
import { fromDatabasePromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import { computeReminderAt } from "../reminder/time.js";

/**
 * Transitions ASKING → DECIDED when every member answered with a time slot (no ABSENT).
 *
 * @remarks
 * state: CAS。成功時のみ `true`。`reminderAt` は decidedStart からのオフセットで計算し、
 *   `reminderSentAt` はこの段階では更新しない。@see src/features/reminder/send.ts
 */
export const tryDecideIfAllTimeSlots = (
  ctx: AppContext,
  session: SessionRow,
  decidedStart: Date
): ResultAsync<boolean, AppError> =>
  safeTry(async function* () {
    // invariant: reminderAt は DECIDED 遷移時に一度だけ決め、送信側は reminderSentAt のみ更新する。
    const reminderAt = computeReminderAt(decidedStart);
    const result = yield* fromDatabasePromise(
      ctx.ports.sessions.decideAsking({
        id: session.id,
        now: ctx.clock.now(),
        decidedStartAt: decidedStart,
        reminderAt
      }),
      "Failed to transition ASKING→DECIDED."
    );
    if (result) {
      logger.info(
        {
          sessionId: session.id,
          weekKey: session.weekKey,
          from: "ASKING",
          to: "DECIDED",
          reason: "all time-choice responses received",
          decidedStartAt: decidedStart.toISOString(),
          reminderAt: reminderAt.toISOString()
        },
        "Session decided."
      );
      return okAsync(true);
    }
    return okAsync(false);
  });
