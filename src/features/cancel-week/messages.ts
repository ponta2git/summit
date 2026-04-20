export const cancelWeekMessages = {
  cancelWeek: {
    confirmPrompt: "本当に今週の運用をスキップしますか？（実行すると今週は運営せず、来週に持ち越します）",
    confirmButtonLabel: "はい、スキップする",
    abortButtonLabel: "キャンセル",
    aborted: "キャンセルしました。今週の運用は継続します。",
    done: (params: { count: number }) =>
      params.count === 0
        ? "今週のスキップ対象はありませんでした。"
        : `今週の運用をスキップしました（対象: ${params.count} 件）。`,
    channelNotice: ({ invokerUserId }: { invokerUserId: string }): string =>
      `🛑 今週は運用都合により見送りです（実行: <@${invokerUserId}>）`,
    suppressedChannelNotice: ({ invokerUserId }: { invokerUserId: string }): string =>
      `🛑 今週は運用都合により見送りです（実行: ${invokerUserId}）`
  }
} as const;
