import {
  check,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const members = pgTable("members", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
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
    candidateDate: date("candidate_date", { mode: "string" }).notNull(),
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
    uniqueIndex("sessions_week_key_postpone_count_unique").on(
      table.weekKey,
      table.postponeCount
    ),
    check(
      "sessions_status_check",
      sql`${table.status} IN ('ASKING','POSTPONE_VOTING','POSTPONED','DECIDED','CANCELLED','COMPLETED','SKIPPED')`
    ),
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
    uniqueIndex("responses_session_member_unique").on(
      table.sessionId,
      table.memberId
    ),
    check(
      "responses_choice_check",
      sql`${table.choice} IN ('T2200','T2230','T2300','T2330','ABSENT','POSTPONE_OK','POSTPONE_NG')`
    )
  ]
);
