import { formatCandidateJa, parseCandidateDateIso } from "../../time/index.js";
import { SLOT_TO_LABEL, type SlotKey } from "../../slot.js";
import { ASK_DEADLINE_HHMM } from "../../config.js";

type AskVoteChoice = "T2200" | "T2230" | "T2300" | "T2330" | "ABSENT";

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
      "🎲 今週の桃鉄1年勝負の出欠確認です",
    unanswered: "未回答",
    footerDecided: ({ startTimeLabel }: AskDecidedFooterParams): string =>
      `✅ 全員回答により ${startTimeLabel} 開始で確定（開催決定メッセージは追って送信）`,
    footerTentative: ({ startTimeLabel }: AskDecidedFooterParams): string =>
      `暫定開始時刻: ${startTimeLabel}（${answerDeadlineLabel} の締切で確定）`,
    footerCancelled: "🛑 中止。この週の募集は締め切りました",
    footerSkipped: "🛑 今週は運用都合により見送りです",
    body: ({ dateIso, statusLines, extraFooter }: AskBodyParams): string => {
      const lines = [
        askMessages.ask.headerLine({ dateIso }),
        "",
        `開催候補日: ${formatCandidateJa(parseCandidateDateIso(dateIso))}`,
        `回答締切: ${answerDeadlineLabel}（未回答者が残っていれば中止）`,
        "ルール: 「欠席」が1人でも出た時点で中止 / 押した時刻 \"以降\" なら参加OK",
        `      （例: ${SLOT_TO_LABEL.T2300} を押すと ${SLOT_TO_LABEL.T2300}/${SLOT_TO_LABEL.T2330} でも参加可能として集計されます）`,
        "",
        "【回答状況】",
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
      `✅ ${count}名の回答で ${slot} 開始に決定しました。`,
    cancelled: (reason: SettleCancelReason): string =>
      reason === "absent"
          ? "🛑 欠席が出たため、今週の開催は中止です。"
        : reason === "deadline_unanswered"
          ? `🛑 ${answerDeadlineLabel} までに未回答者がいたため、今週の開催は中止です。`
          : "🛑 土曜回も成立しなかったため、今週はお流れです。",
    completed: ({ count }: SettleCompletedParams): string =>
      `✅ ${count}名の回答を反映して完了しました。`
  },

  interaction: {
    ask: {
      sent: "送信しました",
      skippedAlreadySent: "本週は既に送信済みのためスキップしました",
      failed: "送信に失敗しました"
    },

    voteConfirmed: {
      ask: (choice: AskVoteChoice): string => {
        const labels: Record<AskVoteChoice, string> = {
          T2200: `${SLOT_TO_LABEL.T2200} OK`,
          T2230: `${SLOT_TO_LABEL.T2230} OK`,
          T2300: `${SLOT_TO_LABEL.T2300} OK`,
          T2330: `${SLOT_TO_LABEL.T2330} OK`,
          ABSENT: "欠席"
        };
        return `回答を受け付けました: ${labels[choice]}`;
      }
    }
  },

  absentConfirm: {
    prompt: "⚠️ 欠席を確定しますか？\n欠席が確定すると今週の開催は中止になります。",
    confirmButtonLabel: "欠席を確定する",
    abortButtonLabel: "キャンセル",
    confirmed: "欠席を確定しました。今週の開催は中止です。",
    aborted: "操作をキャンセルしました。",
    failed: "処理に失敗しました。しばらく待って再試行してください。"
  }
} as const;
