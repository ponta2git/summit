import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const members = pgTable("members", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  displayName: varchar("display_name", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

export const SESSION_STATUSES = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED",
  "COMPLETED",
  "SKIPPED"
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const RESPONSE_CHOICES = [
  "T2200",
  "T2230",
  "T2300",
  "T2330",
  "ABSENT",
  "POSTPONE_OK",
  "POSTPONE_NG"
] as const;

export type ResponseChoice = (typeof RESPONSE_CHOICES)[number];

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    weekKey: text("week_key").notNull(),
    postponeCount: integer("postpone_count").notNull().default(0),
    // why: `Iso` suffix で文字列日付型を名前から識別可能にする。 @see ADR-0014
    candidateDateIso: date("candidate_date_iso", { mode: "string" }).notNull(),
    status: text("status").notNull(),
    channelId: text("channel_id").notNull(),
    askMessageId: text("ask_message_id"),
    postponeMessageId: text("postpone_message_id"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    decidedStartAt: timestamp("decided_start_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    reminderAt: timestamp("reminder_at", { withTimezone: true }),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    // unique: 金 Session (postponeCount=0) と土 Session (postponeCount=1) が週キーを共有するため
    //   複合で 0..1 件に制約。race 時は制約違反 → 呼び出し側が findSessionByWeekKeyAndPostponeCount で再取得。
    uniqueIndex("sessions_week_key_postpone_count_unique").on(
      table.weekKey,
      table.postponeCount
    ),
    // invariant: status を SESSION_STATUSES と DB CHECK で二重ガードし drizzle 型との乖離を防ぐ。
    check(
      "sessions_status_check",
      sql`${table.status} IN ('ASKING','POSTPONE_VOTING','POSTPONED','DECIDED','CANCELLED','COMPLETED','SKIPPED')`
    ),
    // invariant: 順延は 1 回まで (金 → 土)。 @see requirements/base.md §4
    check(
      "sessions_postpone_count_check",
      sql`${table.postponeCount} IN (0, 1)`
    ),
    // why: findDueAskingSessions / findDuePostponeVotingSessions の `WHERE status IN (...) AND deadline_at <= now`
    //   を prefix/range scan で支援するため status を leading column に置いた composite index。
    index("idx_sessions_status_deadline").on(table.status, table.deadlineAt),
    // why: findDueReminderSessions の `status='DECIDED' AND reminder_sent_at IS NULL AND reminder_at <= now`
    //   を prefix scan で支援する composite index。
    index("idx_sessions_status_reminder").on(
      table.status,
      table.reminderSentAt,
      table.reminderAt
    )
  ]
);

export const responses = pgTable(
  "responses",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    choice: text("choice").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    // unique: (sessionId, memberId) で二重回答を排除。押し直しは upsertResponse が
    //   ON CONFLICT DO UPDATE で最新 choice に上書きする。
    uniqueIndex("responses_session_member_unique").on(
      table.sessionId,
      table.memberId
    ),
    // invariant: choice を RESPONSE_CHOICES と DB CHECK で二重ガード。
    check(
      "responses_choice_check",
      sql`${table.choice} IN ('T2200','T2230','T2300','T2330','ABSENT','POSTPONE_OK','POSTPONE_NG')`
    )
  ]
);

// source-of-truth: 実開催履歴 (§8.3)。中止回 (§8.4) では作成しない。
//   DECIDED→COMPLETED CAS と同一 tx で挿入し、「COMPLETED なのに HeldEvent 無し」の
//   永続不整合を回避する (COMPLETED は終端のため起動時リカバリが拾わない)。
export const heldEvents = pgTable("held_events", {
  id: text("id").primaryKey(),
  // unique: 1 Session につき 1 HeldEvent。CAS 勝者のみ挿入するが onConflictDoNothing の anchor として必要。
  sessionId: text("session_id")
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: "cascade" }),
  // why: `Iso` suffix で文字列日付型を明示 (ADR-0014)。値は session.candidate_date_iso に一致。
  heldDateIso: date("held_date_iso", { mode: "string" }).notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

// source-of-truth: 開催ごとの参加メンバースナップショット (§8.3)。
//   env.MEMBER_USER_IDS は「今の設定」であり「その開催の実参加」ではないため、
//   開催時点の responses から派生させた snapshot を保持する。
export const heldEventParticipants = pgTable(
  "held_event_participants",
  {
    heldEventId: text("held_event_id")
      .notNull()
      .references(() => heldEvents.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.heldEventId, table.memberId] })
  ]
);

// source-of-truth: Discord 送信の at-least-once 配送キュー。状態遷移 tx で enqueue し、
//   worker が非同期配送。crash 中でも DB 正本のまま再試行される。 @see ADR-0035
export const OUTBOX_KINDS = ["send_message", "edit_message"] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const OUTBOX_STATUSES = [
  "PENDING",
  "IN_FLIGHT",
  "DELIVERED",
  "FAILED"
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const discordOutbox = pgTable(
  "discord_outbox",
  {
    id: text("id").primaryKey(),
    // source-of-truth: 副作用種別。OUTBOX_KINDS と DB CHECK で二重ガード。
    kind: text("kind").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // why: 送信時に必要な全情報 (channelId / renderer hint / target 列など) を埋め込む。
    //   rehydration は worker 側で担当する。
    payload: jsonb("payload").notNull(),
    // unique: 同じ intent の二重 enqueue を防ぐ per-session の決定論キー。
    //   状態遷移 tx 内で onConflictDoNothing に渡し、重複は skipped=true として上位に通知する。
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    // race: worker の claim で IN_FLIGHT + claim_expires_at=now+ttl をセット。
    //   reconciler は expire 済み IN_FLIGHT を PENDING に戻して reclaim する。
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // source-of-truth: 配送成功時の Discord message id。
    //   payload.target が指す sessions 列 (askMessageId / postponeMessageId) に worker が書き戻す。
    deliveredMessageId: text("delivered_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    // invariant: kind を OUTBOX_KINDS と DB CHECK で二重ガード。
    check(
      "discord_outbox_kind_check",
      sql`${table.kind} IN ('send_message','edit_message')`
    ),
    check(
      "discord_outbox_status_check",
      sql`${table.status} IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED')`
    ),
    // unique: 非 FAILED な同 dedupe_key を 1 件に制約 (PENDING/IN_FLIGHT/DELIVERED で「同一 intent 最大 1」)。
    //   FAILED は dead letter としてスコープ外。partial unique を raw WHERE で表現する。
    uniqueIndex("uq_discord_outbox_dedupe_active")
      .on(table.dedupeKey)
      .where(sql`status IN ('PENDING','IN_FLIGHT','DELIVERED')`),
    // why: claimNextBatch の `status IN ('PENDING','IN_FLIGHT') AND next_attempt_at <= now` を prefix で支援。
    index("idx_discord_outbox_status_next").on(
      table.status,
      table.nextAttemptAt
    )
  ]
);
