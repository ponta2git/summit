export const rejectMessages = {
  reject: {
    notMember: "このボットは登録メンバーのみ操作できます",
    wrongChannel: "このチャンネル以外からは操作できません",
    wrongGuild: "このサーバー以外からは操作できません",
    invalidCustomId: "ボタンの形式が不正です",
    staleSession: "この募集は既に締切されています",
    postponeVotingClosed: "順延投票はすでに締め切られています",
    sessionNotFound: "このセッションは存在しません",
    memberNotRegistered: "メンバー登録がありません",
    outOfScopeButton: "このボタンは対象外です"
  },
  unknownCommand: "未対応コマンドです",
  staleButton: "このボタンは現在有効ではありません。最新のメッセージから操作してください。",
  internalError: "内部エラーが発生しました。管理者に連絡してください。"
} as const;
