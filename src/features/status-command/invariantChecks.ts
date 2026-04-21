// why: /status が表示する stranded invariant の純粋判定関数群。
//   I/O なし。handler が収集済みのデータを受け取り警告文字列を返す。

import type { HeldEventRow, SessionRow } from "../../db/ports.js";

export interface InvariantWarning {
  readonly kind: string;
  readonly message: string;
}

/**
 * ASKING セッションの締切が過去であるにも関わらず状態が ASKING のまま。
 * @remarks
 * cron 処理が走らなかった / crash した場合に発生する stranded 状態。
 */
export const checkAskingWithPastDeadline = (
  session: SessionRow,
  now: Date
): InvariantWarning | undefined => {
  if (session.status !== "ASKING") { return undefined; }
  if (session.deadlineAt <= now) {
    return {
      kind: "asking_past_deadline",
      message: `ASKING session ${session.id.slice(0, 8)} has passed deadline but is not yet settled.`
    };
  }
  return undefined;
};

/**
 * ASKING セッションで askMessageId が null。
 * @remarks
 * createAskSession 後の Discord 送信失敗で発生する stranded 状態。
 * @see docs/reviews/2026-04-21/final-report.md N1
 */
export const checkAskingWithNullMessageId = (
  session: SessionRow
): InvariantWarning | undefined => {
  if (session.status !== "ASKING") { return undefined; }
  if (session.askMessageId === null) {
    return {
      kind: "asking_null_message_id",
      message: `ASKING session ${session.id.slice(0, 8)} has no askMessageId (Discord send may have failed).`
    };
  }
  return undefined;
};

/**
 * DECIDED セッションで reminderSentAt が設定済みだが HeldEvent が存在しない。
 * @remarks
 * claimReminderDispatch 成功後 → completeDecidedSessionAsHeld 前に crash した場合の stale claim。
 * @see docs/adr/0024-reminder-dispatch.md
 */
export const checkDecidedStaleReminderClaim = (
  session: SessionRow,
  heldEvent: HeldEventRow | undefined
): InvariantWarning | undefined => {
  if (session.status !== "DECIDED") { return undefined; }
  if (session.reminderSentAt !== null && heldEvent === undefined) {
    return {
      kind: "decided_stale_reminder_claim",
      message: `DECIDED session ${session.id.slice(0, 8)} has reminderSentAt set but no HeldEvent (stale claim?).`
    };
  }
  return undefined;
};

/**
 * POSTPONE_VOTING セッションの締切が過去。
 */
export const checkPostponeVotingWithPastDeadline = (
  session: SessionRow,
  now: Date
): InvariantWarning | undefined => {
  if (session.status !== "POSTPONE_VOTING") { return undefined; }
  if (session.deadlineAt <= now) {
    return {
      kind: "postpone_voting_past_deadline",
      message: `POSTPONE_VOTING session ${session.id.slice(0, 8)} has passed deadline but is not yet settled.`
    };
  }
  return undefined;
};

/**
 * セッション行に対してすべての invariant チェックを実施し、警告リストを返す。
 */
export const collectInvariantWarnings = (
  session: SessionRow,
  now: Date,
  heldEvent: HeldEventRow | undefined
): readonly InvariantWarning[] => {
  const warnings: InvariantWarning[] = [];

  const w1 = checkAskingWithPastDeadline(session, now);
  if (w1) { warnings.push(w1); }

  const w2 = checkAskingWithNullMessageId(session);
  if (w2) { warnings.push(w2); }

  const w3 = checkDecidedStaleReminderClaim(session, heldEvent);
  if (w3) { warnings.push(w3); }

  const w4 = checkPostponeVotingWithPastDeadline(session, now);
  if (w4) { warnings.push(w4); }

  return warnings;
};
