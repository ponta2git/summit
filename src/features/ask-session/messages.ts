import { formatCandidateJa, parseCandidateDateIso } from "../../time/index.js";
import { SLOT_TO_LABEL, type SlotKey } from "../../slot.js";
import { ASK_DEADLINE_HHMM } from "../../config.js";

export type SettleCancelReason = "absent" | "deadline_unanswered" | "saturday_cancelled";

const formatHhmm = (value: { readonly hour: number; readonly minute: number }): string =>
  `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;

const answerDeadlineLabel = formatHhmm(ASK_DEADLINE_HHMM);

interface AskBodyParams {
  dateIso: string;
  statusLines: string;
  extraFooter?: string;
}

interface AskHeaderLineParams {
  dateIso: string;
}

interface AskDecidedFooterParams {
  startTimeLabel: string;
}

interface SettleDecidedParams {
  slot: SlotKey;
  count: number;
}

interface SettleCompletedParams {
  count: number;
}

export const askMessages = {
  ask: {
    headerLine: (_params: AskHeaderLineParams): string =>
      "🎲 今週の桃鉄1年勝負、出欠確認です",
    unanswered: "未回答",
    footerDecided: ({ startTimeLabel }: AskDecidedFooterParams): string =>
      `✅ みんなの回答がそろいました。${startTimeLabel} 開始で確定です（開催決定を投稿します）`,
    footerTentative: ({ startTimeLabel }: AskDecidedFooterParams): string =>
      `いまの見込み: ${startTimeLabel} 開始（${answerDeadlineLabel} に確定）`,
    footerCancelled: "🛑 今回はお流れです。回答は締め切りました",
    footerSkipped: "🛑 今週の出欠確認はお休みです",
    body: ({ dateIso, statusLines, extraFooter }: AskBodyParams): string => {
      const lines = [
        askMessages.ask.headerLine({ dateIso }),
        "",
        `開催候補日: ${formatCandidateJa(parseCandidateDateIso(dateIso))}`,
        `回答締切: ${answerDeadlineLabel}`,
        "ボタン: 参加できる一番早い時間を選んでください",
        `補足: ${SLOT_TO_LABEL.T2300} を選ぶと ${SLOT_TO_LABEL.T2300}/${SLOT_TO_LABEL.T2330} に参加できるものとして集計します`,
        "予定が合わない場合は「今回は欠席」を選んでください（今回はお流れになります）",
        "",
        "回答状況",
        statusLines
      ];
      if (extraFooter) {
        lines.push("", extraFooter);
      }
      return lines.join("\n");
    }
  },

  settle: {
    decided: ({ slot, count }: SettleDecidedParams): string =>
      `✅ ${count}名の回答で ${slot} 開始に決まりました。`,
    cancelled: (reason: SettleCancelReason): string =>
      reason === "absent"
          ? "🛑 今回は予定がそろわなかったため、お流れです。"
        : reason === "deadline_unanswered"
          ? `🛑 ${answerDeadlineLabel} までに4人分の回答がそろわなかったため、今回はお流れです。`
          : "🛑 土曜回も予定がそろわなかったため、今週はお流れです。",
    completed: ({ count }: SettleCompletedParams): string =>
      `✅ ${count}名の回答を反映して完了しました。`
  },

  interaction: {
    ask: {
      sent: "出欠確認を送信しました",
      skippedAlreadySent: "今週分はすでに出欠確認を送信済みです",
      failed: "出欠確認の送信に失敗しました。少し待ってもう一度お試しください。"
    }
  },

  absentConfirm: {
    prompt: "⚠️ 今回は欠席で送信しますか？\n送信すると、この回はお流れになります。",
    confirmButtonLabel: "今回は欠席で送信する",
    abortButtonLabel: "キャンセル",
    confirmed: "欠席で受け付けました。この回はお流れです。",
    aborted: "キャンセルしました。回答はまだ変わっていません。",
    failed: "処理に失敗しました。少し待ってもう一度お試しください。"
  }
} as const;
