// source-of-truth: session status に対する純粋 predicate。
// @see ADR-0038

import type { SessionStatus } from "../rows.js";
import { assertNever } from "./sessions.internal.js";

export const isNonTerminal = (status: SessionStatus): boolean => {
  // state: 非終端は startup recovery と /cancel_week の対象。CANCELLED は短命中間状態のため除外。 @see ADR-0001
  switch (status) {
    case "ASKING":
    case "POSTPONE_VOTING":
    case "POSTPONED":
    case "DECIDED":
      return true;
    case "CANCELLED":
    case "COMPLETED":
    case "SKIPPED":
      return false;
    default:
      return assertNever(status);
  }
};
