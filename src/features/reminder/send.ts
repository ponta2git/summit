import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.ts";
import type { ResponseChoice, ResponseRow, SessionRow } from "../../db/rows.ts";
import { buildReminderIntent } from "../../db/repositories/sessionOutboxIntents.ts";
import { logger } from "../../logger.ts";
import { appConfig } from "../../userConfig.ts";
import { reminderMessages } from "./messages.ts";

// jst: TZ=Asia/Tokyo 前提で getHours() は JST を返す @see ADR-0002
const formatJstHhmm = (instant: Date): string => {
  const hh = String(instant.getHours()).padStart(2, "0");
  const mm = String(instant.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

const TIME_CHOICES: ReadonlySet<ResponseChoice> = new Set([
  "T2200",
  "T2230",
  "T2300",
  "T2330"
]);

// why: 参加メンバー一覧は responses の時刻選択から派生する。user config の members は「今の設定値」で
//   開催スナップショットではない。DECIDED 到達時点で ABSENT は存在しない (ask-session/decide) ため
//   TIME_CHOICES のみで十分 @see requirements/base.md §8.3
const extractHeldParticipantMemberIds = (
  responses: readonly ResponseRow[]
): readonly string[] =>
  responses
    .filter((r) => TIME_CHOICES.has(r.choice))
    .map((r) => r.memberId);

export const buildReminderContent = (startAt: Date): string => {
  const body = reminderMessages.reminder.body({ startTimeLabel: formatJstHhmm(startAt) });
  // why: dev.suppressMentions=true なら mention 行を省く @see ADR-0011
  if (appConfig.dev.suppressMentions) {
    return body;
  }
  const mentions = appConfig.memberUserIds.map((id) => `<@${id}>`).join(" ");
  return `${mentions}\n${body}`;
};

const completeAfterReminder = async (
  ctx: AppContext,
  session: SessionRow,
  now: Date,
  reason: "reminder_sent" | "reminder_skipped"
): Promise<boolean> => {
  if (!session.decidedStartAt) {
    // invariant: DECIDED session は decidedStartAt を必ず持つ。防御的に早期 return。
    logger.warn(
      { sessionId: session.id, weekKey: session.weekKey, reason },
      "completeAfterReminder invoked without decidedStartAt; skipping."
    );
    return false;
  }
  const responses = await ctx.ports.responses.listResponses(session.id);
  const memberIds = extractHeldParticipantMemberIds(responses);

  // tx: DECIDED→COMPLETED CAS と HeldEvent/participants 挿入を単一 tx にまとめ、
  //   「COMPLETED なのに HeldEvent 無し」の永続不整合を避ける。COMPLETED は終端で
  //   起動時リカバリが拾わないため、別 tx だと失敗時に自然回復しない @see ADR-0031
  const completed = await ctx.ports.heldEvents.completeDecidedSessionAsHeld({
    sessionId: session.id,
    reminderSentAt: now,
    memberIds
  });
  if (!completed) {
    const held = await ctx.ports.heldEvents.findBySessionId(session.id);
    logger.info(
      { sessionId: session.id, weekKey: session.weekKey, from: "DECIDED", to: "COMPLETED", reason: "race lost at reminder completion" },
      "Reminder DECIDED→COMPLETED race; another path completed first."
    );
    return held !== undefined;
  }
  logger.info(
    {
      sessionId: session.id,
      weekKey: session.weekKey,
      from: "DECIDED",
      to: "COMPLETED",
      reason,
      heldEventId: completed.heldEvent.id,
      participantCount: completed.participants.length
    },
    "Session completed after reminder phase."
  );
  return true;
};

/** Finalize a delivered reminder before its outbox claim is acknowledged. */
export const completeReminderDelivery = async (
  ctx: AppContext,
  sessionId: string,
  now: Date
): Promise<boolean> => {
  const session = await ctx.ports.sessions.findSessionById(sessionId);
  if (!session) {return false;}
  if (session.status === "COMPLETED") {
    return (await ctx.ports.heldEvents.findBySessionId(session.id)) !== undefined;
  }
  if (session.status !== "DECIDED") {return false;}
  return completeAfterReminder(ctx, session, now, "reminder_sent");
};

/**
 * Enqueue the 15-minute-before reminder idempotently.
 *
 * @remarks
 * source-of-truth: outbox dedupe が scheduler/recovery の並行 enqueue を吸収する。
 * worker は Discord 投稿後、claim を DELIVERED にする前に DECIDED→COMPLETED と
 * HeldEvent 作成を同一 transaction で確定する。crash 時は重複を許して欠落を防ぐ。
 * @see requirements/base.md §5.2, §9.1
 * @see ADR-0051
 */
export const sendReminderForSession = async (
  _client: Client,
  ctx: AppContext,
  sessionId: string,
  now: Date
): Promise<void> => {
  const fresh = await ctx.ports.sessions.findSessionById(sessionId);
  if (!fresh) {return;}
  if (fresh.status !== "DECIDED") {
    // idempotent: 既に COMPLETED など、他ハンドラが済ませていれば no-op。
    return;
  }
  // compatibility: the former claim-first path wrote reminderSentAt before Discord accepted
  // the message. A DECIDED row with that marker is therefore ambiguous, not complete. The
  // outbox provides the dedupe boundary and the worker completes the Session transactionally.
  if (fresh.decidedStartAt === null) {
    logger.warn(
      { sessionId: fresh.id, weekKey: fresh.weekKey },
      "DECIDED session without decidedStartAt; cannot send reminder."
    );
    return;
  }
  if (fresh.reminderAt === null || now.getTime() < fresh.reminderAt.getTime()) {
    return;
  }

  const enqueued = await ctx.ports.outbox.enqueue(buildReminderIntent(fresh));
  logger.info(
    {
      event: enqueued.skipped ? "reminder.enqueue_skipped" : "reminder.enqueued",
      sessionId: fresh.id,
      weekKey: fresh.weekKey,
      outboxId: enqueued.id
    },
    enqueued.skipped ? "Reminder already queued." : "Reminder queued."
  );
};

/**
 * Transition DECIDED→COMPLETED without sending a reminder (skip rule).
 *
 * @remarks
 * 開催確定時点でリマインド予定までしきい値未満 (§5.2) のときに使う。
 */
export const skipReminderAndComplete = async (
  ctx: AppContext,
  session: SessionRow,
  now: Date
): Promise<void> => {
  await completeAfterReminder(ctx, session, now, "reminder_skipped");
};
