import type { ResponseRow, SessionRow } from "../db/rows.ts";

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

const latestResponsesByMember = (
  session: SessionRow,
  responses: readonly ResponseRow[]
): readonly ResponseRow[] => {
  const deduped = new Map<string, ResponseRow>();
  for (const response of responses) {
    if (response.sessionId !== session.id) {continue;}
    const current = deduped.get(response.memberId);
    if (!current || response.answeredAt.getTime() >= current.answeredAt.getTime()) {
      deduped.set(response.memberId, response);
    }
  }
  return [...deduped.values()];
};

export const evaluatePostponeVote = (
  session: SessionRow,
  responses: readonly ResponseRow[],
  options: EvaluatePostponeVoteOptions
): PostponeDecisionResult => {
  const latestResponses = latestResponsesByMember(session, responses);
  if (latestResponses.some((response) => response.choice === "POSTPONE_NG")) {
    return { kind: "cancelled", reason: "postpone_ng" };
  }

  const okCount = latestResponses.filter(
    (response) => response.choice === "POSTPONE_OK"
  ).length;
  if (okCount >= options.memberCountExpected) {
    return { kind: "all_ok" };
  }
  if (options.now.getTime() >= session.deadlineAt.getTime()) {
    return { kind: "cancelled", reason: "postpone_unanswered" };
  }
  return { kind: "pending" };
};
