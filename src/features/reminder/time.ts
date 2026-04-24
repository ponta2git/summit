import { REMINDER_SKIP_THRESHOLD_MINUTES } from "../../config.js";
import { reminderAtFor } from "../../time/index.js";

/**
 * Decide whether the reminder must be skipped because the decision happened too close to the reminder time.
 *
 * @remarks
 * reminderAt - now が `REMINDER_SKIP_THRESHOLD_MINUTES` 未満なら true。
 * @see requirements/base.md §5.2
 */
export const shouldSkipReminder = (now: Date, reminderAt: Date): boolean => {
  const diffMs = reminderAt.getTime() - now.getTime();
  return diffMs < REMINDER_SKIP_THRESHOLD_MINUTES * 60_000;
};

export const computeReminderAt = (decidedStartAt: Date): Date => reminderAtFor(decidedStartAt);
