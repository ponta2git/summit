// why: 起動時および毎 tick 境界で DB と Discord の invariant を強制する単一の収束点。
//   C1 (CANCELLED 宙づり) / N1 (週次 ask 未作成・削除された Discord message) / H1 (stale reminder claim)
//   を一箇所に集約し、DB を正本とした自動回復を冪等に提供する。
// @see docs/adr/0033-startup-invariant-reconciler.md
// @see docs/reviews/2026-04-21/final-report.md §1 C1 / N1, §2 H1

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
import {
  DISCORD_UNKNOWN_MESSAGE_CODE,
  isUnknownMessageError
} from "../discord/shared/discordErrors.js";

// why: messageEditor / tests が reconciler 経由で参照しているため再 export する。
//   実体は src/discord/shared/discordErrors.ts (循環依存を避ける中立モジュール)。
export { DISCORD_UNKNOWN_MESSAGE_CODE, isUnknownMessageError };

export interface ReconcileReport {
  readonly cancelledPromoted: number;
  readonly askCreated: number;
  readonly messageResent: number;
  readonly staleClaimReclaimed: number;
}

const EMPTY_REPORT: ReconcileReport = {
  cancelledPromoted: 0,
  askCreated: 0,
  messageResent: 0,
  staleClaimReclaimed: 0
};

const FRIDAY_JS_DAY = 5;

// jst: process.env.TZ=Asia/Tokyo 前提で Date#getDay()/getHours() は JST を返す。
// source-of-truth: 窓の開始/終了は src/config.ts の ASK_START_HHMM / ASK_DEADLINE_HHMM を参照する
//   (ADR-0022: ADR/コメントに HH:MM を書き写さない)。
// @see docs/adr/0002-jst-fixed-time-handling.md
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
 * CANCELLED は短命中間状態 (ADR-0001)。プロセスが cancelAsking → 次状態 の間で crash したときに
 * 宙づり行が残る。本関数は次の規則で収束させる:
 *
 * - Saturday (postponeCount=1): 常に `completeCancelledSession` (COMPLETED)。
 * - Friday (postponeCount=0) かつ順延期限前: 順延投票メッセージを投稿し `startPostponeVoting` で POSTPONE_VOTING へ。
 * - Friday (postponeCount=0) かつ順延期限後: `completeCancelledSession` (COMPLETED)。
 *
 * CANCELLED→SKIPPED は許可遷移に無いため (SESSION_ALLOWED_TRANSITIONS)、終端は COMPLETED を採用する。
 * @see docs/adr/0033-startup-invariant-reconciler.md
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
  // state: cancelReason が未記録 / 想定外値の場合は postponeCount から妥当なデフォルトへ。
  return session.postponeCount === 1 ? "saturday_cancelled" : "deadline_unanswered";
};

// race: reconciler の cleanup は通常経路 (settleAskingSession) の 2 ステップ
//   (updateAskMessage → settle 通知送信) をミラーする。crash タイミングが
//   「cancelAsking 後 / settle 通知送信前後」のいずれでも、DB-as-SoT (ADR-0001) 方針として
//   最悪 settle 通知 1 通の重複投稿を許容する (冪等ロックは張らない)。
//   これは「通知が全く出ない」状態を避けるためのベストエフォート。
const emitCancelledUiCleanup = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  // source-of-truth: updateAskMessage 内部で DB から fresh を再取得し disabled=true / footerCancelled
  //   の viewModel で再描画する。10008 時は新規投稿にフォールバックする (ADR-0033 invariant D)。
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
    // state: 土曜回の CANCELLED は順延経路を持たないため COMPLETED へ収束。
    //   先に ASK ボタン無効化 + settle 通知を流してから COMPLETED へ遷移する。
    await emitCancelledUiCleanup(client, ctx, session);
    const completed = await ctx.ports.sessions.completeCancelledSession({
      id: session.id,
      now
    });
    if (!completed) {return undefined;}
    return { to: "COMPLETED", reason: "saturday_cancelled_stranded" };
  }

  // Friday (postponeCount=0) path.
  const candidateDate = parseCandidateDateIso(session.candidateDateIso);
  const postponeDeadline = postponeDeadlineFor(candidateDate);
  if (now.getTime() >= postponeDeadline.getTime()) {
    // state: 順延期限 (候補日翌日 00:00 JST) を過ぎた場合は投票経路が無いので COMPLETED へ。
    await emitCancelledUiCleanup(client, ctx, session);
    const completed = await ctx.ports.sessions.completeCancelledSession({
      id: session.id,
      now
    });
    if (!completed) {return undefined;}
    return { to: "COMPLETED", reason: "friday_postpone_window_elapsed" };
  }

  // state: 順延期限前 (金曜 cancelAsking 直後の crash など) なら POSTPONE_VOTING へ進める。
  //   通常経路 (settleAskingSession) と同じく、先に ASK ボタン無効化 + settle 通知を流してから
  //   順延投票メッセージを送る。
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
 * 金曜 08:00〜21:30 JST の窓で `(weekKey, postponeCount=0)` の Session が無い場合に限り、
 * 通常の `sendAskMessage` 経路で作成する。rolling restart や cron tick 取りこぼし経路の回復点。
 * 窓外では「その週がもう閉じた / まだ始まっていない」と解釈して何もしない。
 * @see docs/reviews/2026-04-21/final-report.md §1 N1
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
 * Invariant C: Recover sessions whose `askMessageId` is NULL.
 *
 * @remarks
 * `createAskSession` 成功後 `channel.send` が失敗すると `askMessageId=NULL` のまま放置され、
 * unique (`weekKey, postponeCount`) で再作成不能になる。ASKING/POSTPONE_VOTING/POSTPONED の
 * いずれの状態でも再投稿し ID を更新する。
 * @see docs/reviews/2026-04-21/final-report.md §1 N1
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
  // source-of-truth: postponeCount=1 (土曜回) は専用送信経路を使い in-flight ロックも共有する。
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
 * claim-first (ADR-0024) が `reminder_sent_at=now` を立てた直後に Discord 送信前後の crash が
 * 起きると、行が `status=DECIDED AND reminder_sent_at IS NOT NULL` で stuck する。
 * staleness (`REMINDER_CLAIM_STALENESS_MS`) を超えた claim を `revertReminderClaim` で NULL に戻し、
 * 次 tick で再送される状態に復元する。
 * @see docs/adr/0024-reminder-dispatch.md
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

export type ReconcileScope = "startup" | "tick";

/**
 * Invariant D (startup active probe): Detect deleted Discord messages at boot.
 *
 * @remarks
 * `updateAskMessage` は opportunistic に 10008 を拾って再投稿するが、起動中に bot が停止しており
 * 誰も interaction を起こさない場合は ask / postpone メッセージが削除されたまま放置される。
 * startup 時だけ `channel.messages.fetch(messageId)` で能動的に probe し、`Unknown Message`
 * (10008) を検知したら新規投稿して ID を差し替える。tick scope では毎分 Discord fetch を叩く
 * コストに見合わないため実施しない。
 * @see docs/reviews/2026-04-21/mid-review-second-opinion.md #2
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
    // state: messageEditor.ts の 10008 フォールバックと同じ viewModel で新規投稿し ID を差し替える。
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
 * Run all reconciliation invariants.
 *
 * @remarks
 * `scope="startup"`: A〜C + E + startup-only active probe (D') を実行。
 *   (通常運転中の invariant D は scheduler tick 側の再描画経路で扱う)。
 * `scope="tick"`: E のみ (stale reminder claim 回収)。起動時より軽量で毎 tick に載せられる。
 * いずれも冪等で DB を正本とする (ADR-0001)。
 * @see docs/adr/0033-startup-invariant-reconciler.md
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

  // Run independently so that one invariant's failure does not block others. Each helper has its own try/catch.
  const cancelledPromoted = await reconcileStrandedCancelled(client, ctx);
  const askCreated = await reconcileMissingAsk(client, ctx);
  const messageResent = await reconcileMissingAskMessage(client, ctx);
  // why: probe は createAskSession / reconcileMissingAskMessage の結果 (新規 askMessageId) も
  //   含めて検証したいので最後に回す。ただし直前に投稿された message は fetch で見つかるため
  //   二重投稿にはならない。
  await probeDeletedMessagesAtStartup(client, ctx);
  const staleClaimReclaimed = await reconcileStaleReminderClaims(ctx);

  return {
    cancelledPromoted,
    askCreated,
    messageResent,
    staleClaimReclaimed
  };
};
