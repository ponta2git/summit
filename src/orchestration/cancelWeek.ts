import type { Client } from "discord.js";
import { type ResultAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.js";
import type { SessionRow } from "../db/rows.js";
import { type AppError, okResult } from "../errors/index.js";
import { fromDatabasePromise, fromDiscordPromise } from "../errors/result.js";
import { askMessages } from "../features/ask-session/messages.js";
import { updateAskMessage } from "../features/ask-session/messageEditor.js";
import { updatePostponeMessage } from "../features/postpone-voting/messageEditor.js";
import { logger } from "../logger.js";
import { appConfig } from "../userConfig.js";
import { isoWeekKey } from "../time/index.js";

export interface SkipWeekOutcome {
  readonly skippedCount: number;
  readonly weekKey: string;
}

/**
 * Apply /cancel_week: transition all non-terminal sessions of the current ISO week to SKIPPED,
 * then repaint cross-feature UI (ask + postpone) and enqueue the channel-wide notice.
 *
 * @remarks
 * jst: 現在時刻から ISO 週キーを算出 (src/time/)。
 * state: CANCELLED は短命中間 (ADR-0001)。対象は実運用上の非終端のみ。
 * idempotent: skipSession は既終端なら undefined。session 単位で冪等。
 * source-of-truth: 再描画は DB 最新から。チャンネル通知は outbox 経由で at-most-once (同週・同 invoker の
 *   dedupe)。
 * @see ADR-0023
 * @see ADR-0035
 * @see ADR-0040
 */
export const applyManualSkip = (
  client: Client,
  ctx: AppContext,
  params: { readonly invokerUserId: string }
): ResultAsync<SkipWeekOutcome, AppError> =>
  safeTry(async function* () {
    const weekKey = isoWeekKey(ctx.clock.now());

    const nonTerminalSessions = yield* fromDatabasePromise(
      ctx.ports.sessions.findNonTerminalSessionsByWeekKey(weekKey),
      "Failed to load non-terminal sessions for manual skip."
    );

    const skipped: SessionRow[] = [];
    for (const session of nonTerminalSessions) {
      const updated = yield* fromDatabasePromise(
        ctx.ports.sessions.skipSession({
          id: session.id,
          cancelReason: "manual_skip"
        }),
        "Failed to skip session manually."
      );
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
      return okResult({ skippedCount: 0, weekKey });
    }

    // source-of-truth: 再描画は常に DB 最新状態から。updateAskMessage は内部で findSessionById する。
    for (const session of skipped) {
      yield* fromDiscordPromise(
        updateAskMessage(client, ctx, session),
        "Failed to update ask message after manual skip."
      );
      if (session.postponeMessageId) {
        const responses = yield* fromDatabasePromise(
          ctx.ports.responses.listResponses(session.id),
          "Failed to load responses for skipped postpone message."
        );
        yield* fromDiscordPromise(
          updatePostponeMessage(
            client,
            ctx,
            session,
            responses,
            askMessages.ask.footerSkipped
          ),
          "Failed to update postpone message after manual skip."
        );
      }
    }

    // idempotent: チャンネル通知は週単位で 1 件のみ (同週・同 invoker の重複 enqueue は dedupe で skipped)。
    //   別 invoker の再実行は別 key で通知し直される。anchor は skipped[0].id (reconciler 紐付け)。
    const anchorSessionId = skipped[0]?.id;
    if (anchorSessionId) {
      const enqueued = yield* fromDatabasePromise(
        ctx.ports.outbox.enqueue({
          kind: "send_message",
          sessionId: anchorSessionId,
          dedupeKey: `cancel-week-notice-${weekKey}-${params.invokerUserId}`,
          payload: {
            kind: "send_message",
            channelId: appConfig.discord.channelId,
            renderer: "cancel_week_notice",
            extra: {
              invokerUserId: params.invokerUserId,
              suppressMentions: appConfig.dev.suppressMentions
            }
          }
        }),
        "Failed to enqueue cancel_week notice."
      );
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

    return okResult({ skippedCount: skipped.length, weekKey });
  });
