import { formatCandidateJa, parseCandidateDateIso } from "./time/index.js";
import type { SlotKey } from "./domain/slot.js";

export type SettleCancelReason = "absent" | "deadline_unanswered" | "saturday_cancelled";

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

interface ReminderBodyParams {
  startTimeLabel: string;
}

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

type AskVoteChoice = "T2200" | "T2230" | "T2300" | "T2330" | "ABSENT";
type PostponeVoteChoice = "ok" | "ng";

// why: user-facing 文言を messages.ts に集約 (ADR-0013)
// source-of-truth: ユーザー向け文言は messages.ts
export const messages = {
  ask: {
    headerLine: (_params: AskHeaderLineParams): string =>
      "🎲 今週の桃鉄1年勝負の出欠確認です",
    unanswered: "未回答",
    footerDecided: ({ startTimeLabel }: AskDecidedFooterParams): string =>
      `✅ 全員回答により ${startTimeLabel} 開始で確定（開催決定メッセージは追って送信）`,
    footerCancelled: "🛑 中止。この週の募集は締め切りました",
    footerSkipped: "🛑 今週は運用都合により見送りです",
    body: ({ dateIso, statusLines, extraFooter }: AskBodyParams): string => {
      const lines = [
        messages.ask.headerLine({ dateIso }),
        "",
        `開催候補日: ${formatCandidateJa(parseCandidateDateIso(dateIso))}`,
        "回答締切: 21:30（未回答者が残っていれば中止）",
        "ルール: 「欠席」が1人でも出た時点で中止 / 押した時刻 \"以降\" なら参加OK",
        "      （例: 23:00 を押すと 23:00/23:30 でも参加可能として集計されます）",
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
          ? "🛑 21:30 までに未回答者がいたため、今週の開催は中止です。"
          : "🛑 土曜回も成立しなかったため、今週はお流れです。",
    completed: ({ count }: SettleCompletedParams): string =>
      `✅ ${count}名の回答を反映して完了しました。`
  },
  reminder: {
    body: ({ startTimeLabel }: ReminderBodyParams): string =>
      `⏰ 15分後に開始です（${startTimeLabel} 開始）`
  },
  postpone: {
    body: ({ candidateDateIso, statusLines }: PostponeBodyParams): string => {
      const lines = [
        "🔁 今週は中止になりました。翌日に順延しますか？",
        "",
        `元の候補日: ${formatCandidateJa(parseCandidateDateIso(candidateDateIso))}`,
        "順延先: 翌日 22:00 以降",
        "回答締切: 候補日翌日 00:00 JST（押さなければ NG 扱い）",
        ""
      ];
      if (statusLines) {
        lines.push("【順延投票】", statusLines, "");
      }
      lines.push("全員が OK を押せば順延確定、1人でも NG / 未回答なら今週はお流れです。");
      return lines.join("\n");
    },
    decided: ({ candidateDateIso, count }: PostponeDecidedParams): string =>
      `✅ ${count}名全員 OK により ${formatCandidateJa(parseCandidateDateIso(candidateDateIso))} へ順延します。`,
    cancelled: ({ reason }: PostponeCancelledParams): string =>
      reason === "ng"
        ? "🛑 1名以上が NG を選択したため、今週はお流れです。"
        : "🛑 未回答があったため、今週はお流れです。"
  },
  interaction: {
    // why: UX 判断 — 拒否理由ごとに具体的な日本語メッセージを返し、ユーザーが「なぜ操作できなかったか」を理解できるようにする。
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
    ask: {
      sent: "送信しました",
      skippedAlreadySent: "本週は既に送信済みのためスキップしました",
      failed: "送信に失敗しました"
    },
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
    },
    postpone: {
      pending: "順延投票は受付準備中です。近日公開予定です。"
    },
    voteConfirmed: {
      ask: (choice: AskVoteChoice): string => {
        const labels: Record<AskVoteChoice, string> = {
          T2200: "22:00 OK",
          T2230: "22:30 OK",
          T2300: "23:00 OK",
          T2330: "23:30 OK",
          ABSENT: "欠席"
        };
        return `回答を受け付けました: ${labels[choice]}`;
      },
      postpone: (choice: PostponeVoteChoice): string => {
        const labels: Record<PostponeVoteChoice, string> = {
          ok: "OK",
          ng: "NG"
        };
        return `順延投票を受け付けました: ${labels[choice]}`;
      }
    },
    unknownCommand: "未対応コマンドです",
    staleButton: "このボタンは現在有効ではありません。最新のメッセージから操作してください。",
    internalError: "内部エラーが発生しました。管理者に連絡してください。"
  }
} as const satisfies {
  ask: {
    headerLine: (params: AskHeaderLineParams) => string;
    unanswered: string;
    footerDecided: (params: AskDecidedFooterParams) => string;
    footerCancelled: string;
    footerSkipped: string;
    body: (params: AskBodyParams) => string;
  };
  settle: {
    decided: (params: SettleDecidedParams) => string;
    cancelled: (reason: SettleCancelReason) => string;
    completed: (params: SettleCompletedParams) => string;
  };
  reminder: {
    body: (params: ReminderBodyParams) => string;
  };
  postpone: {
    body: (params: PostponeBodyParams) => string;
    decided: (params: PostponeDecidedParams) => string;
    cancelled: (params: PostponeCancelledParams) => string;
  };
  interaction: {
    reject: {
      notMember: string;
      wrongChannel: string;
      wrongGuild: string;
        invalidCustomId: string;
        staleSession: string;
        postponeVotingClosed: string;
        sessionNotFound: string;
      memberNotRegistered: string;
      outOfScopeButton: string;
    };
    ask: {
      sent: string;
      skippedAlreadySent: string;
      failed: string;
    };
    cancelWeek: {
      confirmPrompt: string;
      confirmButtonLabel: string;
      abortButtonLabel: string;
      aborted: string;
      done: (params: { count: number }) => string;
      channelNotice: (params: { invokerUserId: string }) => string;
      suppressedChannelNotice: (params: { invokerUserId: string }) => string;
    };
    postpone: {
      pending: string;
    };
    voteConfirmed: {
      ask: (choice: "T2200" | "T2230" | "T2300" | "T2330" | "ABSENT") => string;
      postpone: (choice: "ok" | "ng") => string;
    };
    unknownCommand: string;
    staleButton: string;
    internalError: string;
  };
};
