import type { ResponseRow, SessionRow } from "../../db/types.js";

export type PostponeDecisionResult =
  | { readonly kind: "all_ok" }
  | {
    readonly kind: "cancelled";
    readonly reason: "postpone_ng" | "postpone_unanswered";
  }
  | { readonly kind: "pending" };

export interface EvaluatePostponeVoteOptions {
  readonly memberCountExpected: number;
  readonly now: Date;
}

// invariant: 1 member 1 vote として扱うため、同一 memberId の重複回答は answeredAt が最新の 1 件だけ残す。
const latestResponsesByMember = (
  session: SessionRow,
  responses: readonly ResponseRow[]
): readonly ResponseRow[] => {
  const deduped = new Map<string, ResponseRow>();

  for (const response of responses) {
    if (response.sessionId !== session.id) {
      continue;
    }

    const current = deduped.get(response.memberId);
    // race: 同時押下・再押下で回答が競合しても、最新 answeredAt を正として判定を収束させる。
    if (!current || response.answeredAt.getTime() >= current.answeredAt.getTime()) {
      deduped.set(response.memberId, response);
    }
  }

  return [...deduped.values()];
};

// why: postpone 投票の状態判定を pure 関数へ抽出し、handler/settle の重複ロジックを排除する。
// state: NG が 1 件でもあれば取消。全員 OK で順延確定。期限超過で未回答が残れば取消。
export const evaluatePostponeVote = (
  session: SessionRow,
  responses: readonly ResponseRow[],
  options: EvaluatePostponeVoteOptions
): PostponeDecisionResult => {
  const latestResponses = latestResponsesByMember(session, responses);
  const hasNg = latestResponses.some((response) => response.choice === "POSTPONE_NG");
  if (hasNg) {
    return { kind: "cancelled", reason: "postpone_ng" };
  }

  const okCount = latestResponses.filter((response) => response.choice === "POSTPONE_OK").length;
  if (okCount >= options.memberCountExpected) {
    return { kind: "all_ok" };
  }

  if (options.now.getTime() >= session.deadlineAt.getTime()) {
    return { kind: "cancelled", reason: "postpone_unanswered" };
  }

  return { kind: "pending" };
};
