export const cancelWeekMessages = {
  cancelWeek: {
    confirmPrompt: "今週の出欠確認をお休みにしますか？（出欠確認やリマインドは止まります）",
    confirmButtonLabel: "今週はお休みにする",
    abortButtonLabel: "キャンセル",
    aborted: "キャンセルしました。今週分は続けます。",
    failed: "お休み処理に失敗しました。少し待ってもう一度お試しください。",
    done: (params: { count: number }) =>
      params.count === 0
        ? "お休みにする対象はありませんでした。"
        : `今週分をお休みにしました（対象: ${params.count} 件）。`,
    channelNotice: ({ invokerUserId }: { invokerUserId: string }): string =>
      `🛑 今週の出欠確認はお休みです（実行: <@${invokerUserId}>）`,
    suppressedChannelNotice: ({ invokerUserId }: { invokerUserId: string }): string =>
      `🛑 今週の出欠確認はお休みです（実行: ${invokerUserId}）`
  }
} as const;
