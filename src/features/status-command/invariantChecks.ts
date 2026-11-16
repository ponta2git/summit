import type { OutboxDiagnostic, SessionRow } from "../../db/ports.ts";

export interface InvariantWarning {
  readonly kind: string;
  readonly message: string;
}

type CheckCtx = Readonly<{ now: Date }>;

interface SessionInvariant {
  readonly kind: string;
  readonly predicate: (session: SessionRow, ctx: CheckCtx) => boolean;
  readonly message: (session: SessionRow) => string;
}

const shortId = (id: string): string => id.slice(0, 8);

// invariant: 新規 invariant の追加は SESSION_INVARIANTS に 1 行加えるだけで collectInvariantWarnings に伝播する。
const SESSION_INVARIANTS = {
  askingPastDeadline: {
    kind: "asking_past_deadline",
    predicate: (session, { now }) => session.status === "ASKING" && session.deadlineAt <= now,
    message: (session) =>
      `ASKING session ${shortId(session.id)} has passed deadline but is not yet settled.`
  },

  askingNullMessageId: {
    kind: "asking_null_message_id",
    predicate: (session) => session.status === "ASKING" && session.askMessageId === null,
    message: (session) =>
      `ASKING session ${shortId(session.id)} has no askMessageId (Discord send may have failed).`
  },

  decidedReminderCompletionMismatch: {
    kind: "decided_reminder_completion_mismatch",
    predicate: (session) => session.status === "DECIDED" && session.reminderSentAt !== null,
    message: (session) =>
      `DECIDED session ${shortId(session.id)} has reminderSentAt set before completion.`
  },

  postponeVotingPastDeadline: {
    kind: "postpone_voting_past_deadline",
    predicate: (session, { now }) => session.status === "POSTPONE_VOTING" && session.deadlineAt <= now,
    message: (session) =>
      `POSTPONE_VOTING session ${shortId(session.id)} has passed deadline but is not yet settled.`
  }
} as const satisfies Record<string, SessionInvariant>;

const evaluate = (
  inv: SessionInvariant,
  session: SessionRow,
  ctx: CheckCtx
): InvariantWarning | undefined =>
  inv.predicate(session, ctx) ? { kind: inv.kind, message: inv.message(session) } : undefined;

/**
 * Aggregate 警告: 宙づり CANCELLED セッション。
 *
 * @remarks
 * CANCELLED は短命中間状態。警告が返る場合は reconciler 未稼働を示す。
 */
export const checkStrandedCancelledSessions = (
  strandedSessions: readonly SessionRow[]
): InvariantWarning | undefined => {
  if (strandedSessions.length === 0) {return undefined;}
  const ids = strandedSessions.map((session) => shortId(session.id)).join(", ");
  return {
    kind: "stranded_cancelled",
    message: `${strandedSessions.length} session(s) stuck in CANCELLED (reconciler may not have run): [${ids}]`
  };
};

/**
 * Aggregate 警告: stranded outbox 行 (FAILED / 連続失敗 PENDING)。
 *
 * @remarks
 * attempt_count が `OUTBOX_STRANDED_ATTEMPTS_THRESHOLD` を超えた行や FAILED 行は運用介入が必要。
 * 最古 entry の dedupeKey を含め一次切り分けを容易にする。
 */
export const checkStrandedOutboxEntries = (
  entries: readonly OutboxDiagnostic[]
): InvariantWarning | undefined => {
  if (entries.length === 0) {return undefined;}
  const oldest = entries.reduce((oldestEntry, candidate) =>
    oldestEntry.createdAt.getTime() <= candidate.createdAt.getTime() ? oldestEntry : candidate
  );
  return {
    kind: "outbox_stranded",
    message: `${entries.length} outbox row(s) stranded (FAILED or high attempt_count); oldest dedupeKey="${oldest.dedupeKey}"`
  };
};

export const collectInvariantWarnings = (
  session: SessionRow,
  now: Date
): readonly InvariantWarning[] => {
  const ctx: CheckCtx = { now };
  return Object.values(SESSION_INVARIANTS)
    .map((inv) => evaluate(inv, session, ctx))
    .filter((warning): warning is InvariantWarning => warning !== undefined);
};
