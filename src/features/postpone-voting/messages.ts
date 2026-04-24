import { formatCandidateJa, parseCandidateDateIso } from "../../time/index.js";

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

type PostponeVoteChoice = "ok" | "ng";

export const postponeMessages = {
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
    postpone: {
      pending: "順延投票は受付準備中です。近日公開予定です。"
    },

    voteConfirmed: {
      postpone: (choice: PostponeVoteChoice): string => {
        const labels: Record<PostponeVoteChoice, string> = {
          ok: "OK",
          ng: "NG"
        };
        return `順延投票を受け付けました: ${labels[choice]}`;
      }
    }
  }
} as const;
