import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { askMessages } from "../ask-session/messages.js";
import { isoWeekKey } from "../../time/index.js";
import { updateAskMessage } from "../ask-session/messageEditor.js";
import { updatePostponeMessage } from "../postpone-voting/messageEditor.js";

export interface SkipWeekOutcome {
  readonly skippedCount: number;
  readonly weekKey: string;
}

// why: /cancel_week 用ワークフロー。現在 ISO 週の全非終端 Session を SKIPPED に CAS で遷移し、
//   関連メッセージを disabled で再描画、チャンネル通知を送る。DB が正本、冪等に設計。
// @see docs/adr/0023-cancel-week-command-flow.md
export const applyManualSkip = async (
  client: Client,
  ctx: AppContext,
  params: { readonly invokerUserId: string }
): Promise<SkipWeekOutcome> => {
  // jst: 現在時刻から ISO 週キーを算出。src/time/ に集約 (AGENTS.md rule #1)。
  const weekKey = isoWeekKey(ctx.clock.now());

  // state: ADR-0001 で CANCELLED は短命中間に限定。/cancel_week 対象は実運用上の非終端のみ。
  const nonTerminalSessions = await ctx.ports.sessions.findNonTerminalSessionsByWeekKey(weekKey);

  // idempotent: skipSession は既終端ならば undefined を返す。ここで個別 session 単位で冪等。
  const skipped: SessionRow[] = [];
  for (const session of nonTerminalSessions) {
    const updated = await ctx.ports.sessions.skipSession({
      id: session.id,
      cancelReason: "manual_skip"
    });
    if (updated) {
      logger.info(
        { sessionId: updated.id, weekKey: updated.weekKey, from: session.status, to: "SKIPPED", reason: "manual_skip" },
        "Session skipped via /cancel_week."
      );
      skipped.push(updated);
    }
  }

  logger.info(
    {
      weekKey,
      invokerUserId: params.invokerUserId,
      skippedCount: skipped.length,
      skippedSessionIds: skipped.map((s) => s.id)
    },
    "Manual skip applied."
  );

  if (skipped.length === 0) {
    return { skippedCount: 0, weekKey };
  }

  // source-of-truth: 再描画は常に DB 最新状態から。updateAskMessage は内部で findSessionById 再取得する。
  for (const session of skipped) {
    await updateAskMessage(client, ctx, session);
    if (session.postponeMessageId) {
      const responses = await ctx.ports.responses.listResponses(session.id);
      await updatePostponeMessage(
        client,
        ctx,
        session,
        responses,
        askMessages.ask.footerSkipped
      );
    }
  }

  // why: チャンネル通知は 1 件のみ（週単位のスキップなので Friday/Saturday の両 session で通知を重ねない）。
  //   ADR-0035: outbox 経由にして disconnect 中の送信失敗を worker が retry で拾えるようにする。
  //   dedupe: 同週・同 invoker の重複 enqueue は skipped (at-most-once)。別 invoker の再実行は別 key なので通知し直される。
  //   anchor: sessionId は skipped の先頭 (reconciler の session/outbox 紐付けで利用)。
  const anchorSessionId = skipped[0]?.id;
  if (anchorSessionId) {
    const enqueued = await ctx.ports.outbox.enqueue({
      kind: "send_message",
      sessionId: anchorSessionId,
      dedupeKey: `cancel-week-notice-${weekKey}-${params.invokerUserId}`,
      payload: {
        kind: "send_message",
        channelId: env.DISCORD_CHANNEL_ID,
        renderer: "cancel_week_notice",
        extra: {
          invokerUserId: params.invokerUserId,
          suppressMentions: env.DEV_SUPPRESS_MENTIONS
        }
      }
    });
    logger.info(
      {
        event: enqueued.skipped
          ? "cancel_week.notice_enqueue_skipped"
          : "cancel_week.notice_enqueued",
        weekKey,
        invokerUserId: params.invokerUserId,
        outboxId: enqueued.id,
        skipped: enqueued.skipped
      },
      enqueued.skipped
        ? "cancel_week notice enqueue skipped (duplicate)."
        : "cancel_week notice enqueued to outbox."
    );
  }

  return { skippedCount: skipped.length, weekKey };
};
