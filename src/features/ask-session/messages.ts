import type { CreationRejection } from "../../domain/sessionCreation.ts";
import { formatCandidateJa, parseCandidateDateIso } from "../../time/index.ts";
import { SLOT_TO_LABEL, type SlotKey } from "../../slot.ts";
import { ASK_DEADLINE_HHMM, MEMBER_COUNT_EXPECTED } from "../../config.ts";
import { assertNever } from "../../util/assertNever.ts";

export type SettleCancelReason = "absent" | "deadline_unanswered" | "saturday_cancelled";

const formatHhmm = (value: { readonly hour: number; readonly minute: number }): string =>
  `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;

const answerDeadlineLabel = formatHhmm(ASK_DEADLINE_HHMM);
const expectedMemberCountLabel = `${MEMBER_COUNT_EXPECTED}人分`;

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
      "🎲 桃鉄1年勝負、出欠確認です",
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
          ? `🛑 ${answerDeadlineLabel} までに${expectedMemberCountLabel}の回答がそろわなかったため、今回はお流れです。`
          : "🛑 土曜回も予定がそろわなかったため、この回はお流れです。",
    completed: ({ count }: SettleCompletedParams): string =>
      `✅ ${count}名の回答を反映して完了しました。`
  },

  interaction: {
    ask: {
      queued: "出欠確認を受け付けました。投稿処理を開始します。",
      skippedAlreadySent: "この日の出欠確認はすでに作成されています。",
      rejected: (reason: CreationRejection | "duplicate"): string => {
        switch (reason) {
          case "deadline_passed": return `当日の募集は ${answerDeadlineLabel} より前に開始してください。`;
          case "active_session": return "進行中の出欠確認があります。終了後にもう一度お試しください。";
          case "auto_disabled": return "今週の金曜自動募集は停止されています。手動募集は利用できます。";
          case "outside_auto_window": return "金曜の自動募集時間外です。";
          case "duplicate": return "この操作はすでに受け付けています。";
          case "auto_started": return "今週の金曜自動募集はすでに作成されています。";
          case "date_exists": return "この日の出欠確認はすでに作成されています。";
          default: return assertNever(reason, "ask rejection reason");
        }
      },
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
