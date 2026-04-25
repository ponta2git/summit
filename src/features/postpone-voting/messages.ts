import { formatCandidateJa, parseCandidateDateIso } from "../../time/index.js";
import { POSTPONE_DEADLINE_HHMM } from "../../config.js";
import { SLOT_TO_LABEL } from "../../slot.js";

interface PostponeBodyParams {
  candidateDateIso: string;
  // source-of-truth: statusLines が空文字列のときは【順延投票】セクション全体を省略（初期投稿時の互換）
  statusLines?: string;
}

interface PostponeDecidedParams {
  candidateDateIso: string;
  count: number;
}

interface PostponeCancelledParams {
  reason: "ng" | "unanswered";
}

const formatPostponeDeadline = (): string =>
  POSTPONE_DEADLINE_HHMM.hour === 24 && POSTPONE_DEADLINE_HHMM.minute === 0
    ? "候補日翌日 00:00 JST"
    : `${String(POSTPONE_DEADLINE_HHMM.hour).padStart(2, "0")}:${String(POSTPONE_DEADLINE_HHMM.minute).padStart(2, "0")} JST`;

export const postponeMessages = {
  postpone: {
    body: ({ candidateDateIso, statusLines }: PostponeBodyParams): string => {
      const lines = [
        "🔁 今回はお流れです。明日も募集しますか？",
        "",
        `元の候補日: ${formatCandidateJa(parseCandidateDateIso(candidateDateIso))}`,
        `順延先: 翌日 ${SLOT_TO_LABEL.T2200} 以降`,
        `回答締切: ${formatPostponeDeadline()}`,
        ""
      ];
      if (statusLines) {
        lines.push("【順延投票】", statusLines, "");
      }
      lines.push(
        "明日も募集OK = 明日もう一度、出欠確認を送ります（参加確定ではありません）",
        "全員分そろえば明日の出欠確認へ進みます。そろわなければ今週はお流れです。"
      );
      return lines.join("\n");
    },

    decided: ({ candidateDateIso, count }: PostponeDecidedParams): string =>
      `✅ ${count}名全員が「明日も募集OK」なので、${formatCandidateJa(parseCandidateDateIso(candidateDateIso))} の出欠確認へ進みます。`,
    cancelled: ({ reason }: PostponeCancelledParams): string =>
      reason === "ng"
        ? "🛑 今週はお流れです。予定がそろわない人がいました。"
        : "🛑 今週はお流れです。締切までに4人分の回答がそろいませんでした。"
  },

  interaction: {
    postpone: {
      pending: "順延投票はまだ準備中です。少し待ってください。"
    }
  },

  ngConfirm: {
    prompt:
      "⚠️ 今週はお流れで送信しますか？\n送信すると、この順延確認は終了します。",
    confirmButtonLabel: "今週はお流れにする",
    abortButtonLabel: "キャンセル",
    confirmed: "今週はお流れで受け付けました。",
    aborted: "キャンセルしました。回答はまだ変わっていません。",
    failed: "処理に失敗しました。少し待ってもう一度お試しください。"
  }
} as const;
