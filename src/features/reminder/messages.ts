import { REMINDER_LEAD_MINUTES } from "../../config.ts";

interface ReminderBodyParams {
  startTimeLabel: string;
}

export const reminderMessages = {
  reminder: {
    body: ({ startTimeLabel }: ReminderBodyParams): string =>
      `⏰ ${REMINDER_LEAD_MINUTES}分後に開始です（${startTimeLabel} 開始）`
  }
} as const;
