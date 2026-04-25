export const rejectMessages = {
  reject: {
    notMember: "このボットは登録メンバーだけ使えます",
    wrongChannel: "出欠用チャンネルで操作してください",
    wrongGuild: "このサーバーでは使えません",
    invalidCustomId: "このボタンは読み取れません。最新のメッセージから操作してください。",
    staleSession: "この出欠確認は締め切り済みです",
    askingClosed: "回答締切を過ぎました",
    postponeVotingClosed: "この順延確認は締め切り済みです",
    sessionNotFound: "この出欠確認は見つかりません",
    memberNotRegistered: "メンバー登録が見つかりません",
    outOfScopeButton: "このボタンは現在使えません"
  },

  unknownCommand: "このコマンドには対応していません",
  staleButton: "このボタンは現在使えません。最新のメッセージから操作してください。",
  internalError: "うまく処理できませんでした。少し待ってもう一度お試しください。"
} as const;
