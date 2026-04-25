import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import type { ResponseChoice, ResponseRow, SessionRow } from "../../db/rows.js";
import { logger } from "../../logger.js";
import { appConfig } from "../../userConfig.js";
import { reminderMessages } from "./messages.js";

import { getTextChannel } from "../../discord/shared/channels.js";

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

const buildReminderContent = (startAt: Date): string => {
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
): Promise<void> => {
  if (!session.decidedStartAt) {
    // invariant: DECIDED session は decidedStartAt を必ず持つ。防御的に早期 return。
    logger.warn(
      { sessionId: session.id, weekKey: session.weekKey, reason },
      "completeAfterReminder invoked without decidedStartAt; skipping."
    );
    return;
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
 * source-of-truth: DB から最新 Session を再取得して処理する。
 * race: Discord 送信の**前に** `claimReminderDispatch` で条件付き UPDATE により claim を確保し、
 *   cron tick と起動時 recovery の並行送信を DB 層で防ぐ。
 * idempotent: 敗者 (undefined) は no-op。COMPLETED / 送信済みも no-op。
 * 失敗回復: 送信が throw したら `revertReminderClaim` で claim を戻し次 tick で再試行。
 *   at-least-once: 送信後 throw では重複送信を受容する (§5.2「送る」優先)。
 * @see requirements/base.md §5.2, §9.1
 * @see ADR-0024
 */
export const sendReminderForSession = async (
  client: Client,
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

  // race: claim-first。DB 層で先着 1 件のみ勝者とし、以降は undefined を観測する。
  const claimed = await ctx.ports.sessions.claimReminderDispatch(fresh.id, now);
  if (!claimed) {
    logger.info(
      { sessionId: fresh.id, weekKey: fresh.weekKey },
      "Reminder claim lost race; another path already claimed dispatch."
    );
    return;
  }

  const content = buildReminderContent(claimed.decidedStartAt ?? fresh.decidedStartAt);

  try {
    const channel = await getTextChannel(client, claimed.channelId);
    await channel.send(content);
  } catch (error: unknown) {
    // race: 送信失敗時は claim を戻し DECIDED + reminderSentAt=NULL に復元し次 tick で再試行。
    //   at-least-once: API throw でも実際には配送済みだった場合、次 tick で重複送信し得る。
    //   §5.2 の「送る」を優先し欠落より重複を選ぶ。
    const reverted = await ctx.ports.sessions.revertReminderClaim(fresh.id, now);
    logger.warn(
      { error, sessionId: fresh.id, weekKey: fresh.weekKey, reverted },
      "Failed to send reminder; reverted claim, will retry on next tick."
    );
    return;
  }

  await completeAfterReminder(ctx, claimed, now, "reminder_sent");
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
