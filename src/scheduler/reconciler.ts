// why: 起動時および毎 tick 境界で DB と Discord の invariant を強制する単一の収束点。
//   C1 (CANCELLED 宙づり) / N1 (週次 ask 未作成・削除された Discord message) / H1 (stale reminder claim)
//   を一箇所に集約し、DB を正本とした自動回復を冪等に提供する。
// @see docs/adr/0033-startup-invariant-reconciler.md
// @see docs/reviews/2026-04-21/final-report.md §1 C1 / N1, §2 H1

import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import {
  ASK_DEADLINE_HHMM,
  REMINDER_CLAIM_STALENESS_MS
} from "../config.js";
import type { SessionRow } from "../db/rows.js";
import { sendAskMessage, sendPostponedAskMessage } from "../features/ask-session/send.js";
import { renderAskBody } from "../features/ask-session/render.js";
import { buildAskMessageViewModel } from "../features/ask-session/viewModel.js";
import { renderPostponeBody } from "../features/postpone-voting/render.js";
import { buildPostponeMessageViewModel } from "../features/postpone-voting/viewModel.js";
import { logger } from "../logger.js";
import {
  isoWeekKey,
  parseCandidateDateIso,
  postponeDeadlineFor
} from "../time/index.js";
import { getTextChannel } from "../discord/shared/channels.js";

// why: discord.js が投げる DiscordAPIError の code で "Unknown Message" を判別する。
//   定数値は discord-api-types RESTJSONErrorCodes.UnknownMessage (10008) に一致。
//   直接 import すると transitive dep に依存するため数値で固定する。
// @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
export const DISCORD_UNKNOWN_MESSAGE_CODE = 10008;

export const isUnknownMessageError = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === DISCORD_UNKNOWN_MESSAGE_CODE;
};

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
// @see docs/adr/0002-jst-fixed-time-handling.md
const isFridayAskWindow = (now: Date): boolean => {
  if (now.getDay() !== FRIDAY_JS_DAY) {return false;}
  const hour = now.getHours();
  const minute = now.getMinutes();
  const afterAsk = hour > 8 || (hour === 8 && minute >= 0);
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

const promoteStranded = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  now: Date
): Promise<{ readonly to: "POSTPONE_VOTING" | "COMPLETED"; readonly reason: string } | undefined> => {
  if (session.postponeCount === 1) {
    // state: 土曜回の CANCELLED は順延経路を持たないため COMPLETED へ収束。
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
    const completed = await ctx.ports.sessions.completeCancelledSession({
      id: session.id,
      now
    });
    if (!completed) {return undefined;}
    return { to: "COMPLETED", reason: "friday_postpone_window_elapsed" };
  }

  // state: 順延期限前 (金曜 cancelAsking 直後の crash など) なら POSTPONE_VOTING へ進める。
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
  const cutoff = new Date(now.getTime() - REMINDER_CLAIM_STALENESS_MS);
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
 * Run all reconciliation invariants.
 *
 * @remarks
 * `scope="startup"`: A〜C + E を全て実行 (invariant D は scheduler tick 側の再描画経路で扱う)。
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
  const staleClaimReclaimed = await reconcileStaleReminderClaims(ctx);

  return {
    cancelledPromoted,
    askCreated,
    messageResent,
    staleClaimReclaimed
  };
};
