import type { OutboxEntry, SessionRow } from "../../db/ports.ts";

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

  decidedReminderCompletionMismatch: {
    kind: "decided_reminder_completion_mismatch",
    predicate: (s) => s.status === "DECIDED" && s.reminderSentAt !== null,
    message: (s) =>
      `DECIDED session ${shortId(s.id)} has reminderSentAt set before completion.`
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
  const ids = strandedSessions.map((s) => shortId(s.id)).join(", ");
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

export const collectInvariantWarnings = (
  session: SessionRow,
  now: Date
): readonly InvariantWarning[] => {
  const ctx: CheckCtx = { now };
  return Object.values(SESSION_INVARIANTS)
    .map((inv) => evaluate(inv, session, ctx))
    .filter((w): w is InvariantWarning => w !== undefined);
};
