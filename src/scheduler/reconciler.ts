import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import {
  ASK_DEADLINE_HHMM,
  ASK_START_HHMM,
  REMINDER_CLAIM_STALENESS_MS
} from "../config.js";
import type { SessionRow } from "../db/rows.js";
import { sendAskMessage, sendPostponedAskMessage } from "../features/ask-session/send.js";
import { renderAskBody } from "../features/ask-session/render.js";
import {
  buildAskMessageViewModel,
  buildSettleNoticeViewModel,
  renderSettleNotice
} from "../features/ask-session/viewModel.js";
import { updateAskMessage } from "../features/ask-session/messageEditor.js";
import type { SettleCancelReason } from "../features/ask-session/messages.js";
import { renderPostponeBody } from "../features/postpone-voting/render.js";
import { buildPostponeMessageViewModel } from "../features/postpone-voting/viewModel.js";
import { logger } from "../logger.js";
import {
  isoWeekKey,
  parseCandidateDateIso,
  postponeDeadlineFor,
  subMs
} from "../time/index.js";
import { getTextChannel } from "../discord/shared/channels.js";
import { isUnknownMessageError } from "../discord/shared/discordErrors.js";

export interface ReconcileReport {
  readonly cancelledPromoted: number;
  readonly askCreated: number;
  readonly messageResent: number;
  readonly staleClaimReclaimed: number;
  readonly outboxClaimReleased: number;
}

const EMPTY_REPORT: ReconcileReport = {
  cancelledPromoted: 0,
  askCreated: 0,
  messageResent: 0,
  staleClaimReclaimed: 0,
  outboxClaimReleased: 0
};

const FRIDAY_JS_DAY = 5;

// jst: Date#getDay/getHours は process.env.TZ=Asia/Tokyo 前提で JST を返す。
// source-of-truth: 窓境界は src/config.ts の ASK_START_HHMM / ASK_DEADLINE_HHMM。
// @see ADR-0002
const isFridayAskWindow = (now: Date): boolean => {
  if (now.getDay() !== FRIDAY_JS_DAY) {return false;}
  const hour = now.getHours();
  const minute = now.getMinutes();
  const afterAsk =
    hour > ASK_START_HHMM.hour ||
    (hour === ASK_START_HHMM.hour && minute >= ASK_START_HHMM.minute);
  const beforeDeadline =
    hour < ASK_DEADLINE_HHMM.hour ||
    (hour === ASK_DEADLINE_HHMM.hour && minute < ASK_DEADLINE_HHMM.minute);
  return afterAsk && beforeDeadline;
};

/**
 * Invariant A: Promote stranded CANCELLED sessions to their next canonical state.
 *
 * @remarks
 * state: CANCELLED は短命中間状態 (ADR-0001)。crash 等で宙づり行が残った場合に収束させる。
 * 土曜 (postponeCount=1) は COMPLETED、金曜は順延期限前なら POSTPONE_VOTING、期限後は COMPLETED。
 * CANCELLED→SKIPPED は許可遷移に無いため終端は COMPLETED を採用する。
 * @see ADR-0033
 */
export const reconcileStrandedCancelled = async (
  client: Client,
  ctx: AppContext
): Promise<number> => {
  const stranded = await ctx.ports.sessions.findStrandedCancelledSessions();
  let promoted = 0;
  const now = ctx.clock.now();

  for (const session of stranded) {
    try {
      const next = await promoteStranded(client, ctx, session, now);
      if (next) {
        promoted += 1;
        logger.info(
          {
            event: "reconciler.cancelled_promoted",
            sessionId: session.id,
            weekKey: session.weekKey,
            from: "CANCELLED",
            to: next.to,
            reason: next.reason
          },
          "Reconciler: promoted stranded CANCELLED session."
        );
      }
    } catch (error: unknown) {
      logger.error(
        {
          error,
          event: "reconciler.cancelled_promoted_failed",
          sessionId: session.id,
          weekKey: session.weekKey
        },
        "Reconciler: failed to promote stranded CANCELLED session."
      );
    }
  }
  return promoted;
};

const resolveSettleCancelReason = (session: SessionRow): SettleCancelReason => {
  const reason = session.cancelReason;
  if (
    reason === "absent" ||
    reason === "deadline_unanswered" ||
    reason === "saturday_cancelled"
  ) {
    return reason;
  }
  // state: cancelReason 未記録 / 想定外値は postponeCount から妥当なデフォルトへ fallback。
  return session.postponeCount === 1 ? "saturday_cancelled" : "deadline_unanswered";
};

// race: cleanup は通常経路 (settleAskingSession) の updateAskMessage → settle 通知送信 を
//   ミラーする。crash 時は settle 通知 1 通の重複投稿を許容 (DB-as-SoT, ADR-0001)。
const emitCancelledUiCleanup = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  await updateAskMessage(client, ctx, session);
  const channel = await getTextChannel(client, session.channelId);
  const settleVm = buildSettleNoticeViewModel(resolveSettleCancelReason(session));
  await channel.send(renderSettleNotice(settleVm));
};

const promoteStranded = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): Promise<{ readonly to: "POSTPONE_VOTING" | "COMPLETED"; readonly reason: string } | undefined> => {
  if (session.postponeCount === 1) {
    // state: 土曜回の CANCELLED は順延経路が無いため UI cleanup → COMPLETED。
    await emitCancelledUiCleanup(client, ctx, session);
    const completed = await ctx.ports.sessions.completeCancelledSession({
      id: session.id,
      now
    });
    if (!completed) {return undefined;}
    return { to: "COMPLETED", reason: "saturday_cancelled_stranded" };
  }

  const candidateDate = parseCandidateDateIso(session.candidateDateIso);
  const postponeDeadline = postponeDeadlineFor(candidateDate);
  if (now.getTime() >= postponeDeadline.getTime()) {
    // state: 順延期限超過なら投票経路無しで COMPLETED に収束。
    await emitCancelledUiCleanup(client, ctx, session);
    const completed = await ctx.ports.sessions.completeCancelledSession({
      id: session.id,
      now
    });
    if (!completed) {return undefined;}
    return { to: "COMPLETED", reason: "friday_postpone_window_elapsed" };
  }

  // state: 順延期限前は UI cleanup → 順延投票メッセージ送信 → POSTPONE_VOTING へ。
  await emitCancelledUiCleanup(client, ctx, session);
  const channel = await getTextChannel(client, session.channelId);
  const postponeVm = buildPostponeMessageViewModel(session);
  const sent = await channel.send(renderPostponeBody(postponeVm));
  await ctx.ports.sessions.updatePostponeMessageId(session.id, sent.id);
  const transitioned = await ctx.ports.sessions.startPostponeVoting({
    id: session.id,
    now,
    postponeDeadlineAt: postponeDeadline
  });
  if (!transitioned) {return undefined;}
  return { to: "POSTPONE_VOTING", reason: "friday_cancel_resumed" };
};

/**
 * Invariant B: Ensure this week's Friday ASKING session exists during the publication window.
 *
 * @remarks
 * 金曜の ASK 窓 (src/config.ts ASK_START_HHMM / ASK_DEADLINE_HHMM) 内で
 * `(weekKey, postponeCount=0)` Session が無い場合のみ通常経路で作成する。窓外では no-op。
 * @see ADR-0033
 */
export const reconcileMissingAsk = async (
  client: Client,
  ctx: AppContext
): Promise<number> => {
  const now = ctx.clock.now();
  if (!isFridayAskWindow(now)) {
    return 0;
  }

  const weekKey = isoWeekKey(now);
  const existing = await ctx.ports.sessions.findSessionByWeekKeyAndPostponeCount(weekKey, 0);
  if (existing) {
    return 0;
  }

  try {
    const result = await sendAskMessage(client, { trigger: "cron", context: ctx });
    if (result.status === "sent") {
      logger.info(
        {
          event: "reconciler.ask_created",
          sessionId: result.sessionId,
          weekKey: result.weekKey,
          messageId: result.messageId
        },
        "Reconciler: created missing Friday ASKING session."
      );
      return 1;
    }
    return 0;
  } catch (error: unknown) {
    logger.error(
      { error, event: "reconciler.ask_created_failed", weekKey },
      "Reconciler: failed to create missing Friday ASKING session."
    );
    return 0;
  }
};

/**
 * Invariant C: Recover non-terminal sessions whose `askMessageId` is NULL.
 *
 * @remarks
 * `createAskSession` 成功後 `channel.send` 失敗で askMessageId=NULL のまま放置されると
 * (weekKey, postponeCount) unique で再作成不能になる。ASKING/POSTPONE_VOTING/POSTPONED を
 * 対象に再投稿して ID を埋める。
 * @see ADR-0033
 */
export const reconcileMissingAskMessage = async (
  client: Client,
  ctx: AppContext
): Promise<number> => {
  const nonTerminal = await ctx.ports.sessions.findNonTerminalSessions();
  let resent = 0;
  for (const session of nonTerminal) {
    if (session.askMessageId) {continue;}
    if (
      session.status !== "ASKING" &&
      session.status !== "POSTPONE_VOTING" &&
      session.status !== "POSTPONED"
    ) {
      continue;
    }
    try {
      await resendAskMessage(client, ctx, session);
      resent += 1;
    } catch (error: unknown) {
      logger.error(
        {
          error,
          event: "reconciler.message_resent_failed",
          sessionId: session.id,
          weekKey: session.weekKey
        },
        "Reconciler: failed to resend ask message."
      );
    }
  }
  return resent;
};

const resendAskMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  // source-of-truth: postponeCount=1 の ASKING は専用経路で送信し in-flight ロックを共有する。
  if (session.postponeCount === 1 && session.status === "ASKING") {
    await sendPostponedAskMessage(client, ctx, session);
    logger.info(
      {
        event: "reconciler.message_resent",
        sessionId: session.id,
        weekKey: session.weekKey,
        status: session.status
      },
      "Reconciler: resent postponed Saturday ask message."
    );
    return;
  }

  const channel = await getTextChannel(client, session.channelId);
  const memberRows = await ctx.ports.members.listMembers();
  const responses = await ctx.ports.responses.listResponses(session.id);
  const vm = buildAskMessageViewModel(session, responses, memberRows);
  const sent = await channel.send(renderAskBody(vm));
  await ctx.ports.sessions.updateAskMessageId(session.id, sent.id);
  logger.info(
    {
      event: "reconciler.message_resent",
      sessionId: session.id,
      weekKey: session.weekKey,
      messageId: sent.id,
      status: session.status
    },
    "Reconciler: resent ask message."
  );
};

/**
 * Invariant E: Reclaim stale reminder claims left behind by a crashed dispatch.
 *
 * @remarks
 * race: claim-first (ADR-0024) が `reminder_sent_at=now` 直後に crash すると
 * `status=DECIDED AND reminder_sent_at IS NOT NULL` で stuck する。
 * `REMINDER_CLAIM_STALENESS_MS` を超えた claim を NULL に戻し次 tick で再送させる。
 * @see ADR-0024
 */
export const reconcileStaleReminderClaims = async (
  ctx: AppContext
): Promise<number> => {
  const now = ctx.clock.now();
  const cutoff = subMs(now, REMINDER_CLAIM_STALENESS_MS);
  const stale = await ctx.ports.sessions.findStaleReminderClaims(cutoff);
  let reclaimed = 0;
  for (const session of stale) {
    if (session.reminderSentAt === null) {continue;}
    const staleSinceMs = now.getTime() - session.reminderSentAt.getTime();
    try {
      const ok = await ctx.ports.sessions.revertReminderClaim(
        session.id,
        session.reminderSentAt
      );
      if (ok) {
        reclaimed += 1;
        logger.warn(
          {
            event: "reconciler.reminder_claim_reclaimed",
            sessionId: session.id,
            weekKey: session.weekKey,
            staleSinceMs
          },
          "Reconciler: reverted stale reminder claim."
        );
      }
    } catch (error: unknown) {
      logger.error(
        {
          error,
          event: "reconciler.reminder_claim_reclaimed_failed",
          sessionId: session.id,
          weekKey: session.weekKey
        },
        "Reconciler: failed to revert stale reminder claim."
      );
    }
  }
  return reclaimed;
};

/**
 * Invariant F: Release IN_FLIGHT outbox rows past their claim deadline.
 *
 * @remarks
 * race: worker が claim 中に crash すると IN_FLIGHT で stuck する。startup/reconnect で
 * PENDING に戻し次 worker tick で再配送させる。
 * @see ADR-0035
 */
export const reconcileOutboxClaims = async (
  ctx: AppContext
): Promise<number> => {
  try {
    const released = await ctx.ports.outbox.releaseExpiredClaims(ctx.clock.now());
    if (released > 0) {
      logger.warn(
        { event: "reconciler.outbox_claim_reclaimed", released },
        "Reconciler: released expired outbox claims."
      );
    }
    return released;
  } catch (error: unknown) {
    logger.error(
      { error, event: "reconciler.outbox_claim_reclaim_failed" },
      "Reconciler: failed to release expired outbox claims."
    );
    return 0;
  }
};

export type ReconcileScope = "startup" | "tick" | "reconnect";

/**
 * Invariant D (startup active probe): Detect deleted Discord messages at boot.
 *
 * @remarks
 * `updateAskMessage` は opportunistic に 10008 を拾って再投稿するが、停止中は interaction が
 * 無いため ask / postpone メッセージが削除されたまま放置される。startup 時のみ能動的に fetch し、
 * Unknown Message (10008) 検知で新規投稿して ID を差し替える。tick scope では毎分 fetch コストに
 * 見合わないため実施しない。
 * @see ADR-0033
 */
export const probeDeletedMessagesAtStartup = async (
  client: Client,
  ctx: AppContext
): Promise<number> => {
  const nonTerminal = await ctx.ports.sessions.findNonTerminalSessions();
  let recreated = 0;
  for (const session of nonTerminal) {
    try {
      if (await probeAndRecreateAskMessage(client, ctx, session)) {
        recreated += 1;
      }
      if (await probeAndRecreatePostponeMessage(client, ctx, session)) {
        recreated += 1;
      }
    } catch (error: unknown) {
      logger.error(
        {
          error,
          event: "reconciler.message_probe_failed",
          sessionId: session.id,
          weekKey: session.weekKey
        },
        "Reconciler: failed to probe session messages at startup."
      );
    }
  }
  return recreated;
};

const probeAndRecreateAskMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<boolean> => {
  if (!session.askMessageId) {return false;}
  const channel = await getTextChannel(client, session.channelId);
  logger.debug(
    {
      event: "reconciler.message_probed",
      sessionId: session.id,
      weekKey: session.weekKey,
      kind: "ask",
      messageId: session.askMessageId
    },
    "Reconciler: probing ask message."
  );
  try {
    await channel.messages.fetch(session.askMessageId);
    return false;
  } catch (error: unknown) {
    if (!isUnknownMessageError(error)) {
      logger.warn(
        {
          error,
          event: "reconciler.message_probe_error",
          sessionId: session.id,
          weekKey: session.weekKey,
          kind: "ask",
          messageId: session.askMessageId
        },
        "Reconciler: ask message probe failed with non-10008 error."
      );
      return false;
    }
    // state: messageEditor.ts の 10008 フォールバックと同 viewModel で新規投稿し ID を差し替え。
    const memberRows = await ctx.ports.members.listMembers();
    const fresh = await ctx.ports.sessions.findSessionById(session.id);
    if (!fresh) {return false;}
    const responses = await ctx.ports.responses.listResponses(fresh.id);
    const vm = buildAskMessageViewModel(fresh, responses, memberRows);
    const sent = await channel.send(renderAskBody(vm));
    await ctx.ports.sessions.updateAskMessageId(session.id, sent.id);
    logger.warn(
      {
        event: "reconciler.message_recreated_at_startup",
        sessionId: session.id,
        weekKey: session.weekKey,
        kind: "ask",
        previousMessageId: session.askMessageId,
        messageId: sent.id
      },
      "Reconciler: recreated deleted ask message detected at startup."
    );
    return true;
  }
};

const probeAndRecreatePostponeMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<boolean> => {
  if (session.status !== "POSTPONE_VOTING" && session.status !== "POSTPONED") {
    return false;
  }
  if (!session.postponeMessageId) {return false;}
  const channel = await getTextChannel(client, session.channelId);
  logger.debug(
    {
      event: "reconciler.message_probed",
      sessionId: session.id,
      weekKey: session.weekKey,
      kind: "postpone",
      messageId: session.postponeMessageId
    },
    "Reconciler: probing postpone message."
  );
  try {
    await channel.messages.fetch(session.postponeMessageId);
    return false;
  } catch (error: unknown) {
    if (!isUnknownMessageError(error)) {
      logger.warn(
        {
          error,
          event: "reconciler.message_probe_error",
          sessionId: session.id,
          weekKey: session.weekKey,
          kind: "postpone",
          messageId: session.postponeMessageId
        },
        "Reconciler: postpone message probe failed with non-10008 error."
      );
      return false;
    }
    const postponeVm = buildPostponeMessageViewModel(session);
    const sent = await channel.send(renderPostponeBody(postponeVm));
    await ctx.ports.sessions.updatePostponeMessageId(session.id, sent.id);
    logger.warn(
      {
        event: "reconciler.message_recreated_at_startup",
        sessionId: session.id,
        weekKey: session.weekKey,
        kind: "postpone",
        previousMessageId: session.postponeMessageId,
        messageId: sent.id
      },
      "Reconciler: recreated deleted postpone message detected at startup."
    );
    return true;
  }
};

/**
 * Run all reconciliation invariants for the given scope.
 *
 * @remarks
 * idempotent: いずれの scope も DB を正本として冪等に収束させる (ADR-0001)。
 * - `startup`: A〜C + E + F + invariant D (active probe)。
 * - `reconnect`: A〜C + E + F (D は毎再接続で fetch させないため除外)。
 *    in-flight lock / debounce は呼び出し側が保証する (ADR-0036)。
 * - `tick`: E のみ (毎 tick 境界で軽量に stale reminder claim を回収)。
 * @see ADR-0033
 * @see ADR-0036
 */
export const runReconciler = async (
  client: Client,
  ctx: AppContext,
  options: { readonly scope: ReconcileScope }
): Promise<ReconcileReport> => {
  if (options.scope === "tick") {
    const staleClaimReclaimed = await reconcileStaleReminderClaims(ctx);
    return { ...EMPTY_REPORT, staleClaimReclaimed };
  }

  const cancelledPromoted = await reconcileStrandedCancelled(client, ctx);
  const askCreated = await reconcileMissingAsk(client, ctx);
  const messageResent = await reconcileMissingAskMessage(client, ctx);
  // why: active probe は startup 限定。reconnect は毎回 Discord fetch するコストに見合わず、
  //   scheduler tick の opportunistic な updateAskMessage に委ねる。
  if (options.scope === "startup") {
    await probeDeletedMessagesAtStartup(client, ctx);
  }
  const staleClaimReclaimed = await reconcileStaleReminderClaims(ctx);
  const outboxClaimReleased = await reconcileOutboxClaims(ctx);

  return {
    cancelledPromoted,
    askCreated,
    messageResent,
    staleClaimReclaimed,
    outboxClaimReleased
  };
};
