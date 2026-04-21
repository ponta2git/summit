import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { askMessages } from "../ask-session/messages.js";
import { cancelWeekMessages } from "./messages.js";
import { isoWeekKey } from "../../time/index.js";
import { getTextChannel } from "../../discord/shared/channels.js";
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
  try {
    const channel = await getTextChannel(client, env.DISCORD_CHANNEL_ID);
    const content = env.DEV_SUPPRESS_MENTIONS
      ? cancelWeekMessages.cancelWeek.suppressedChannelNotice({
          invokerUserId: params.invokerUserId
        })
      : cancelWeekMessages.cancelWeek.channelNotice({
          invokerUserId: params.invokerUserId
        });
    await channel.send({ content });
  } catch (error: unknown) {
    // race: チャンネル通知の失敗は本処理（DB 更新・メッセージ disable）に影響させない。
    logger.warn(
      { error, weekKey, invokerUserId: params.invokerUserId },
      "Failed to send cancel_week channel notice."
    );
  }

  return { skippedCount: skipped.length, weekKey };
};
