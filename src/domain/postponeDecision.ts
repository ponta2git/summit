import type { ResponseRow, SessionRow } from "../db/rows.ts";

export type PostponeDecisionResult =
  | { readonly kind: "all_ok" }
  | {
      readonly kind: "cancelled";
      readonly reason: "postpone_ng" | "postpone_unanswered";
    }
  | { readonly kind: "pending" };

interface EvaluatePostponeVoteOptions {
  readonly memberCountExpected: number;
  readonly now: Date;
}

/** Evaluate the locked Session/Response snapshot; storage owns session scope and one current answer per member. */
export const evaluatePostponeVote = (
  session: SessionRow,
  responses: readonly ResponseRow[],
  options: EvaluatePostponeVoteOptions
): PostponeDecisionResult => {
  if (responses.some((response) => response.choice === "POSTPONE_NG")) {
    return { kind: "cancelled", reason: "postpone_ng" };
  }

  const okCount = responses.filter(
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
