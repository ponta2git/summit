export const cancelWeekMessages = {
  cancelWeek: {
    confirmPrompt: "今週の金曜自動募集を停止しますか？ 作成済みの募集・リマインドと手動募集はそのまま利用できます。",
    confirmButtonLabel: "金曜自動募集を停止",
    abortButtonLabel: "キャンセル",
    aborted: "キャンセルしました。自動募集の設定は変更していません。",
    expired: "週が変わったため、この確認は期限切れです。/cancel_week をやり直してください。",
    failed: "お休み処理に失敗しました。少し待ってもう一度お試しください。",
    done: (kind: "applied" | "already_disabled" | "already_started"): string =>
      kind === "applied" ? "今週の金曜自動募集を停止しました。手動募集は利用できます。"
        : kind === "already_disabled" ? "今週の金曜自動募集はすでに停止されています。"
          : "今週の金曜自動募集はすでに作成されているため、変更していません。",
    channelNotice: ({ invokerUserId }: { invokerUserId: string }): string =>
      `🛑 今週の出欠確認はお休みです（実行: <@${invokerUserId}>）`,
    suppressedChannelNotice: ({ invokerUserId }: { invokerUserId: string }): string =>
      `🛑 今週の出欠確認はお休みです（実行: ${invokerUserId}）`
  }
} as const;
