import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";
import { type ResultAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.ts";
import type { SessionRow } from "../db/rows.ts";
import { type AppError, okResult } from "../errors/index.ts";
import { fromDatabaseCall } from "../errors/result.ts";
import { updateAskMessage } from "../features/ask-session/messageEditor.ts";
import { updatePostponeMessage } from "../features/postpone-voting/messageEditor.ts";
import { logger } from "../logger.ts";
import {
  candidateDateForAsk,
  deadlineFor,
  formatCandidateDateIso,
  isoWeekKey
} from "../time/index.ts";
import { appConfig } from "../userConfig.ts";

export type SkipWeekOutcome = { readonly kind: "expired" } | {
  readonly kind: "applied";
  readonly skippedCount: number;
  readonly weekKey: string;
};

const repaintSkippedSession = (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): ResultAsync<void, never> =>
  safeTry(async function* () {
    const keepCommittedCancellation = (messageKind: "ask" | "postpone") => (error: AppError) => {
      logger.warn({ event: "cancel_week.repaint_failed", sessionId: session.id, weekKey: session.weekKey, messageKind, error },
        "Cancellation is committed; a message could not be repainted.");
      return okAsync(undefined);
    };
    yield* updateAskMessage(client, ctx, session).orElse(keepCommittedCancellation("ask"));
    if (session.postponeMessageId) {
      yield* updatePostponeMessage(client, ctx, session).orElse(keepCommittedCancellation("postpone"));
    }
    return okResult(undefined);
  });

/**
 * Apply /cancel_week as one week-level transaction, then repaint affected messages.
 */
export const applyManualSkip = (
  client: Client,
  ctx: AppContext,
  params: { readonly invokerUserId: string; readonly expectedWeekKey: string }
): ResultAsync<SkipWeekOutcome, AppError> =>
  safeTry(async function* () {
    const now = ctx.clock.now();
    const weekKey = isoWeekKey(now);
    if (weekKey !== params.expectedWeekKey) {
      return okResult({ kind: "expired" as const });
    }
    const candidateDate = candidateDateForAsk(now);
    const outcome = yield* fromDatabaseCall(
      () => ctx.ports.sessionCommands.cancelWeekAtomically({
        sentinelSessionId: randomUUID(),
        weekKey,
        candidateDateIso: formatCandidateDateIso(candidateDate),
        channelId: appConfig.discord.channelId,
        deadlineAt: deadlineFor(candidateDate),
        invokerUserId: params.invokerUserId,
        suppressMentions: appConfig.dev.suppressMentions,
        now
      }),
      "Failed to skip current week atomically."
    );

    if (outcome.kind === "already_held") {
      logger.warn(
        {
          weekKey,
          sessionId: outcome.session.id,
          invokerUserId: params.invokerUserId
        },
        "Manual skip ignored because the week already has a held event."
      );
      return okResult({ kind: "applied" as const, skippedCount: 0, weekKey });
    }
    if (outcome.kind === "already_closed") {
      logger.info(
        { weekKey, invokerUserId: params.invokerUserId },
        "Manual skip found only already-closed sessions."
      );
      return okResult({ kind: "applied" as const, skippedCount: 0, weekKey });
    }

    for (const session of outcome.skippedSessions) {
      yield* repaintSkippedSession(client, ctx, session);
    }
    logger.info(
      {
        weekKey,
        invokerUserId: params.invokerUserId,
        skippedCount: outcome.skippedSessions.length,
        skippedSessionIds: outcome.skippedSessions.map((session) => session.id),
        sentinelCreated: outcome.sentinelCreated,
        noticeEnqueued: outcome.noticeEnqueued
      },
      "Manual skip applied atomically."
    );
    return okResult({
      kind: "applied" as const,
      skippedCount: outcome.skippedSessions.length,
      weekKey
    });
  });
