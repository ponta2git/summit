// why: ask-session が発行する週キャンセルの理由語彙。settle で通知 / DB 記録に使う。
export type CancelReason =
  | "absent"
  | "deadline_unanswered"
  | "postpone_ng"
  | "postpone_unanswered"
  | "saturday_cancelled";
