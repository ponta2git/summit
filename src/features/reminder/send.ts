import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import { REMINDER_SKIP_THRESHOLD_MINUTES } from "../../config.js";
import type { ResponseChoice, ResponseRow, SessionRow } from "../../db/rows.js";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { reminderMessages } from "./messages.js";
import { reminderAtFor } from "../../time/index.js";

import { getTextChannel } from "../../discord/shared/channels.js";

// why: HH:MM を JST で整形する。process.env.TZ=Asia/Tokyo 前提で Date#getHours() は JST を返す。
// @see docs/adr/0002-jst-fixed-time-handling.md
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

// why: §8.3 「参加メンバー一覧」を responses の時刻選択から派生させる。
//   env.MEMBER_USER_IDS は「今の設定値」であり「その開催の実参加スナップショット」ではない。
//   DECIDED 到達時点で ABSENT は存在しない (decide.ts) ため、TIME_CHOICES のみで十分。
const extractHeldParticipantMemberIds = (
  responses: readonly ResponseRow[]
): readonly string[] =>
  responses
    .filter((r) => TIME_CHOICES.has(r.choice))
    .map((r) => r.memberId);

const buildReminderContent = (startAt: Date): string => {
  const body = reminderMessages.reminder.body({ startTimeLabel: formatJstHhmm(startAt) });
  // why: DEV_SUPPRESS_MENTIONS=true なら mention 行を省く（settle と同じ方針）。
  // @see docs/adr/0011-dev-mention-suppression.md
  if (env.DEV_SUPPRESS_MENTIONS) {
    return body;
  }
  const mentions = env.MEMBER_USER_IDS.map((id) => `<@${id}>`).join(" ");
  return `${mentions}\n${body}`;
};

/**
 * Determine whether the reminder must be skipped because the decision happened too close to the reminder time.
 *
 * @remarks
 * 開催確定 (now) からリマインド予定時刻まで 10 分未満なら送らない（requirements/base.md §5.2）。
 * reminderAt - now < THRESHOLD のときに true を返す。
 */
export const shouldSkipReminder = (now: Date, reminderAt: Date): boolean => {
  const diffMs = reminderAt.getTime() - now.getTime();
  return diffMs < REMINDER_SKIP_THRESHOLD_MINUTES * 60_000;
};

/**
 * Compute `reminderAt` from a decided start instant.
 */
export const computeReminderAt = (decidedStartAt: Date): Date => reminderAtFor(decidedStartAt);

const completeAfterReminder = async (
  ctx: AppContext,
  session: SessionRow,
  now: Date,
  reason: "reminder_sent" | "reminder_skipped"
): Promise<void> => {
  if (!session.decidedStartAt) {
    // invariant: DECIDED session は decidedStartAt を必ず持つ。防御的に早期 return。
    logger.warn(
      { sessionId: session.id, weekKey: session.weekKey, reason },
      "completeAfterReminder invoked without decidedStartAt; skipping."
    );
    return;
  }
  // source-of-truth: HeldEvent の参加者は responses の時刻選択 (§8.3) から派生する。
  const responses = await ctx.ports.responses.listResponses(session.id);
  const memberIds = extractHeldParticipantMemberIds(responses);

  // tx: DECIDED→COMPLETED CAS と HeldEvent/participants 挿入を単一 tx でまとめ、
  //   「COMPLETED なのに HeldEvent 無し」の永続不整合を避ける。COMPLETED は終端で
  //   起動時リカバリが拾わないため、別 tx に分けると失敗時に自然回復しない。
  // @see docs/adr/0031-held-event-persistence.md
  const completed = await ctx.ports.heldEvents.completeDecidedSessionAsHeld({
    sessionId: session.id,
    reminderSentAt: now,
    memberIds
  });
  if (!completed) {
    // race: 別ハンドラが先に COMPLETED へ遷移させた race lost。DB を巻き戻さない。
    logger.info(
      { sessionId: session.id, weekKey: session.weekKey, from: "DECIDED", to: "COMPLETED", reason: "race lost at reminder completion" },
      "Reminder DECIDED→COMPLETED race; another path completed first."
    );
    return;
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
};

/**
 * Send the 15-minute-before reminder and transition DECIDED→COMPLETED.
 *
 * @remarks
 * DB を正本とし、呼び出し時点で Session を再取得してから処理する。
 * `reminder_sent_at IS NULL` AND `status=DECIDED` でなければ no-op（冪等）。
 * メッセージ送信失敗時は COMPLETED へ遷移させず、次の tick で再試行する。
 * @see requirements/base.md §5.2, §9.1
 */
export const sendReminderForSession = async (
  client: Client,
  ctx: AppContext,
  sessionId: string,
  now: Date
): Promise<void> => {
  // source-of-truth: DB から最新状態を取り直す。in-memory 状態を信じない。
  const fresh = await ctx.ports.sessions.findSessionById(sessionId);
  if (!fresh) {return;}
  if (fresh.status !== "DECIDED") {
    // idempotent: 既に COMPLETED など、他ハンドラが済ませていれば no-op。
    return;
  }
  if (fresh.reminderSentAt !== null) {
    // idempotent: 既に送信済みなら再送しない。
    return;
  }
  if (fresh.decidedStartAt === null) {
    logger.warn(
      { sessionId: fresh.id, weekKey: fresh.weekKey },
      "DECIDED session without decidedStartAt; cannot send reminder."
    );
    return;
  }

  const content = buildReminderContent(fresh.decidedStartAt);

  try {
    const channel = await getTextChannel(client, fresh.channelId);
    await channel.send(content);
  } catch (error: unknown) {
    // source-of-truth: 送信失敗時は DECIDED のまま据え置き、次 tick で再試行する。
    logger.warn(
      { error, sessionId: fresh.id, weekKey: fresh.weekKey },
      "Failed to send reminder; will retry on next tick."
    );
    return;
  }

  await completeAfterReminder(ctx, fresh, now, "reminder_sent");
};

/**
 * Transition DECIDED→COMPLETED without sending a reminder (skip rule).
 *
 * @remarks
 * 開催確定時点でリマインド予定まで 10 分未満 (§5.2) のときに使う。送信 tick 側では使わない。
 */
export const skipReminderAndComplete = async (
  ctx: AppContext,
  session: SessionRow,
  now: Date
): Promise<void> => {
  await completeAfterReminder(ctx, session, now, "reminder_skipped");
};
