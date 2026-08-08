import type { ResponseRow, SessionRow } from "../db/rows.ts";
import { isSlotKey } from "../slot.ts";
import {
  decidedStartAt,
  latestChoice,
  parseCandidateDateIso,
  type AskTimeChoice
} from "../time/index.ts";

export type SlotKey = AskTimeChoice;

export type DecisionResult =
  | { kind: "decided"; startAt: Date; chosenSlot: SlotKey }
  | { kind: "cancelled"; reason: "all_absent" | "deadline_unanswered" }
  | { kind: "pending"; reason: "not_all_answered_and_not_overdue" };

export interface EvaluateDeadlineOptions {
  memberCountExpected: number;
  now: Date;
}

const isAskTimeChoice = (choice: ResponseRow["choice"]): choice is AskTimeChoice =>
  isSlotKey(choice);

/**
 * Evaluate an ASKING aggregate from one locked Session/Response snapshot.
 *
 * @remarks
 * Pure (no I/O, no global clock). ABSENT is immediate; time choices settle only at deadline.
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

  if (session.deadlineAt.getTime() > options.now.getTime()) {
    return { kind: "pending", reason: "not_all_answered_and_not_overdue" };
  }

  if (allTimeChoices) {
    const chosenSlot = latestChoice(timeChoices);
    const startAt = decidedStartAt(parseCandidateDateIso(session.candidateDateIso), timeChoices);
    if (chosenSlot && startAt) {
      return { kind: "decided", startAt, chosenSlot };
    }
  }

  return { kind: "cancelled", reason: "deadline_unanswered" };
};
