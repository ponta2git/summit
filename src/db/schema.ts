import {
  check,
  date,
  integer,
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
    // why: 型形式を名前で明示 Iso suffix (ADR-0014)
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
    // unique: (weekKey, postponeCount) で同一週×順延回数の Session を 0..1 件に制約。
    //   金曜 Session (postponeCount=0) と土曜 Session (postponeCount=1) は同一週キーを共有するため
    //   複合ユニークでないと両立できない。sendAskMessage / createAskSession の race は
    //   この制約違反で検出し、呼び出し側は findSessionByWeekKeyAndPostponeCount で再取得して skipped を返す。
    uniqueIndex("sessions_week_key_postpone_count_unique").on(
      table.weekKey,
      table.postponeCount
    ),
    // invariant: status は SESSION_STATUSES と DB CHECK で二重ガード。
    //   DB 側で未知状態の書き込みを弾くことで drizzle 型と実データの乖離を防ぐ。
    check(
      "sessions_status_check",
      sql`${table.status} IN ('ASKING','POSTPONE_VOTING','POSTPONED','DECIDED','CANCELLED','COMPLETED','SKIPPED')`
    ),
    // invariant: 順延は 1 回まで (金 → 土)。postponeCount >= 2 は仕様違反。
    // @see requirements/base.md §4
    check(
      "sessions_postpone_count_check",
      sql`${table.postponeCount} IN (0, 1)`
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
    // unique: (sessionId, memberId) で同一メンバーの二重回答を排除。
    //   4 名同時押下 / 同一メンバーの連打は unique 違反として ON CONFLICT で最後の choice に upsert する。
    // race: upsertResponse が ON CONFLICT DO UPDATE を使う根拠。
    uniqueIndex("responses_session_member_unique").on(
      table.sessionId,
      table.memberId
    ),
    // invariant: choice は RESPONSE_CHOICES と二重ガード。未知値を DB 層で拒否する。
    check(
      "responses_choice_check",
      sql`${table.choice} IN ('T2200','T2230','T2300','T2330','ABSENT','POSTPONE_OK','POSTPONE_NG')`
    )
  ]
);

// source-of-truth: 実開催履歴。将来の戦績集計システム統合前提 (§8.3)。
//   中止回 (CANCELLED / SKIPPED) では作成しない (§8.4)。DECIDED→COMPLETED 遷移と
//   同一トランザクションで挿入することで「COMPLETED なのに HeldEvent 無し」の
//   永続不整合を回避する (COMPLETED は終端のため起動時リカバリが拾わない)。
export const heldEvents = pgTable("held_events", {
  id: text("id").primaryKey(),
  // unique: 1 Session につき 1 HeldEvent。CAS 勝者のみ挿入するため本来競合しないが
  //   再実行時の冪等性 (onConflictDoNothing) を担保する anchor として機能する。
  sessionId: text("session_id")
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: "cascade" }),
  // why: 型形式を名前で明示 Iso suffix (ADR-0014)。実開催日 = session.candidate_date_iso。
  heldDateIso: date("held_date_iso", { mode: "string" }).notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

// source-of-truth: 開催ごとの参加メンバースナップショット (§8.3 "参加メンバー一覧")。
//   env.MEMBER_USER_IDS は「今の設定」であり「その開催の実参加」ではないため、
//   開催時点の responses (時刻選択) から派生させた snapshot を保持する。
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
