interface ReminderBodyParams {
  startTimeLabel: string;
}

export const reminderMessages = {
  reminder: {
    body: ({ startTimeLabel }: ReminderBodyParams): string =>
      `⏰ 15分後に開始です（${startTimeLabel} 開始）`
  }
} as const;
