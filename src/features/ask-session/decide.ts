import type { ResponseRow, SessionRow } from "../../db/rows.js";
import { isSlotKey } from "../../slot.js";
import {
  decidedStartAt,
  latestChoice,
  parseCandidateDateIso,
  type AskTimeChoice
} from "../../time/index.js";

export type SlotKey = AskTimeChoice;

export type DecisionResult =
  | { kind: "decided"; startAt: Date; chosenSlot: SlotKey }
  | { kind: "cancelled"; reason: "all_absent" | "deadline_unanswered" }
  | { kind: "pending"; reason: "not_all_answered_and_not_overdue" };

export interface EvaluateDeadlineOptions {
  memberCountExpected: number;
  now?: Date;
}

const isAskTimeChoice = (choice: ResponseRow["choice"]): choice is AskTimeChoice =>
  isSlotKey(choice);

/**
 * Evaluate an ASKING session's deadline decision.
 *
 * @remarks
 * Pure (no I/O, no `Date.now()`). Callers inject `options.now` for deadline comparison.
 * source-of-truth: ask session 締切判定の正本。
 */
export const evaluateDeadline = (
  session: SessionRow,
  responses: readonly ResponseRow[],
  options: EvaluateDeadlineOptions
): DecisionResult => {
  if (responses.some((response) => response.choice === "ABSENT")) {
    return { kind: "cancelled", reason: "all_absent" };
  }

  const allAnswered = responses.length === options.memberCountExpected;
  const timeChoices = responses
    .map((response) => response.choice)
    .filter(isAskTimeChoice);
  const allTimeChoices = allAnswered && timeChoices.length === responses.length;

  if (allTimeChoices) {
    const chosenSlot = latestChoice(timeChoices);
    const startAt = decidedStartAt(parseCandidateDateIso(session.candidateDateIso), timeChoices);
    if (chosenSlot && startAt) {
      return { kind: "decided", startAt, chosenSlot };
    }
  }

  if (options.now && session.deadlineAt.getTime() <= options.now.getTime()) {
    return { kind: "cancelled", reason: "deadline_unanswered" };
  }

  return { kind: "pending", reason: "not_all_answered_and_not_overdue" };
};
