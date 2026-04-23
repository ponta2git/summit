// why: /status が表示する stranded invariant の純粋判定関数群。
//   I/O なし。handler が収集済みのデータを受け取り警告文字列を返す。

import type { HeldEventRow, OutboxEntry, SessionRow } from "../../db/ports.js";

export interface InvariantWarning {
  readonly kind: string;
  readonly message: string;
}

type CheckCtx = Readonly<{ now: Date; heldEvent: HeldEventRow | undefined }>;

interface SessionInvariant {
  readonly kind: string;
  readonly predicate: (session: SessionRow, ctx: CheckCtx) => boolean;
  readonly message: (session: SessionRow) => string;
}

const shortId = (id: string): string => id.slice(0, 8);

// invariant: 各 entry は session に対する単一 invariant を表現する。新規追加は table に 1 行加えるだけで collectInvariantWarnings に伝播する。
//   @see docs/adr/0033-startup-invariant-reconciler.md
const SESSION_INVARIANTS = {
  askingPastDeadline: {
    kind: "asking_past_deadline",
    predicate: (s, { now }) => s.status === "ASKING" && s.deadlineAt <= now,
    message: (s) =>
      `ASKING session ${shortId(s.id)} has passed deadline but is not yet settled.`
  },
  askingNullMessageId: {
    kind: "asking_null_message_id",
    predicate: (s) => s.status === "ASKING" && s.askMessageId === null,
    message: (s) =>
      `ASKING session ${shortId(s.id)} has no askMessageId (Discord send may have failed).`
  },
  decidedStaleReminderClaim: {
    kind: "decided_stale_reminder_claim",
    predicate: (s, { heldEvent }) =>
      s.status === "DECIDED" && s.reminderSentAt !== null && heldEvent === undefined,
    message: (s) =>
      `DECIDED session ${shortId(s.id)} has reminderSentAt set but no HeldEvent (stale claim?).`
  },
  postponeVotingPastDeadline: {
    kind: "postpone_voting_past_deadline",
    predicate: (s, { now }) => s.status === "POSTPONE_VOTING" && s.deadlineAt <= now,
    message: (s) =>
      `POSTPONE_VOTING session ${shortId(s.id)} has passed deadline but is not yet settled.`
  }
} as const satisfies Record<string, SessionInvariant>;

const evaluate = (
  inv: SessionInvariant,
  session: SessionRow,
  ctx: CheckCtx
): InvariantWarning | undefined =>
  inv.predicate(session, ctx) ? { kind: inv.kind, message: inv.message(session) } : undefined;

// why: 既存テスト/呼び出し側との後方互換のため、4 つの per-session check は名前付き wrapper として残す。
//   実装は SESSION_INVARIANTS table に集約済み。
export const checkAskingWithPastDeadline = (
  session: SessionRow,
  now: Date
): InvariantWarning | undefined =>
  evaluate(SESSION_INVARIANTS.askingPastDeadline, session, { now, heldEvent: undefined });

export const checkAskingWithNullMessageId = (
  session: SessionRow
): InvariantWarning | undefined =>
  evaluate(SESSION_INVARIANTS.askingNullMessageId, session, {
    now: new Date(0),
    heldEvent: undefined
  });

export const checkDecidedStaleReminderClaim = (
  session: SessionRow,
  heldEvent: HeldEventRow | undefined
): InvariantWarning | undefined =>
  evaluate(SESSION_INVARIANTS.decidedStaleReminderClaim, session, { now: new Date(0), heldEvent });

export const checkPostponeVotingWithPastDeadline = (
  session: SessionRow,
  now: Date
): InvariantWarning | undefined =>
  evaluate(SESSION_INVARIANTS.postponeVotingPastDeadline, session, {
    now,
    heldEvent: undefined
  });

/**
 * 宙づり CANCELLED セッションが存在する場合の aggregate 警告。
 *
 * @remarks
 * `CANCELLED` は短命中間状態 (ADR-0001)。通常は瞬時に次状態へ遷移するため、
 * この関数が警告を返す場合は reconciler が未稼働か crash で止まっていることを示す。
 * @see docs/adr/0033-startup-invariant-reconciler.md
 */
export const checkStrandedCancelledSessions = (
  strandedSessions: readonly SessionRow[]
): InvariantWarning | undefined => {
  if (strandedSessions.length === 0) {return undefined;}
  const ids = strandedSessions.map((s) => shortId(s.id)).join(", ");
  return {
    kind: "stranded_cancelled",
    message: `${strandedSessions.length} session(s) stuck in CANCELLED (reconciler may not have run): [${ids}]`
  };
};

/**
 * Stranded outbox 行 (FAILED / 連続失敗 PENDING) を aggregate 警告化する。
 *
 * @remarks
 * ADR-0035: worker が dead letter (FAILED) に落とした行、もしくは attempt_count が
 * `OUTBOX_STRANDED_ATTEMPTS_THRESHOLD` を超えた PENDING / IN_FLIGHT は運用者の介入が必要。
 * 最古 entry の dedupeKey を含めることで一次切り分けを容易にする。
 * @see docs/adr/0035-discord-send-outbox.md
 */
export const checkStrandedOutboxEntries = (
  entries: readonly OutboxEntry[]
): InvariantWarning | undefined => {
  if (entries.length === 0) {return undefined;}
  const oldest = entries.reduce((a, b) =>
    a.createdAt.getTime() <= b.createdAt.getTime() ? a : b
  );
  return {
    kind: "outbox_stranded",
    message: `${entries.length} outbox row(s) stranded (FAILED or high attempt_count); oldest dedupeKey="${oldest.dedupeKey}"`
  };
};

/**
 * セッション行に対してすべての session invariant を評価し、警告リストを返す。
 */
export const collectInvariantWarnings = (
  session: SessionRow,
  now: Date,
  heldEvent: HeldEventRow | undefined
): readonly InvariantWarning[] => {
  const ctx: CheckCtx = { now, heldEvent };
  return Object.values(SESSION_INVARIANTS)
    .map((inv) => evaluate(inv, session, ctx))
    .filter((w): w is InvariantWarning => w !== undefined);
};
