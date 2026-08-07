import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";
import { type ResultAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.js";
import type { SessionRow } from "../db/rows.js";
import { type AppError, okResult } from "../errors/index.js";
import { fromDatabasePromise } from "../errors/result.js";
import { askMessages } from "../features/ask-session/messages.js";
import { updateAskMessage } from "../features/ask-session/messageEditor.js";
import { updatePostponeMessage } from "../features/postpone-voting/messageEditor.js";
import { logger } from "../logger.js";
import {
  candidateDateForAsk,
  deadlineFor,
  formatCandidateDateIso,
  isoWeekKey
} from "../time/index.js";
import { appConfig } from "../userConfig.js";

export interface SkipWeekOutcome {
  readonly skippedCount: number;
  readonly weekKey: string;
}

const repaintSkippedSession = (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    yield* updateAskMessage(client, ctx, session);
    if (session.postponeMessageId) {
      const responses = yield* fromDatabasePromise(
        ctx.ports.responses.listResponses(session.id),
        "Failed to load responses for skipped postpone message."
      );
      yield* updatePostponeMessage(
        client,
        ctx,
        session,
        responses,
        askMessages.ask.footerSkipped
      );
    }
    return okResult(undefined);
  });

/**
 * Apply /cancel_week as one week-level transaction, then repaint affected messages.
 */
export const applyManualSkip = (
  client: Client,
  ctx: AppContext,
  params: { readonly invokerUserId: string }
): ResultAsync<SkipWeekOutcome, AppError> =>
  safeTry(async function* () {
    const now = ctx.clock.now();
    const weekKey = isoWeekKey(now);
    const candidateDate = candidateDateForAsk(now);
    const outcome = yield* fromDatabasePromise(
      ctx.ports.sessionCommands.cancelWeekAtomically({
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
      return okResult({ skippedCount: 0, weekKey });
    }
    if (outcome.kind === "already_closed") {
      logger.info(
        { weekKey, invokerUserId: params.invokerUserId },
        "Manual skip found only already-closed sessions."
      );
      return okResult({ skippedCount: 0, weekKey });
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
      skippedCount: outcome.skippedSessions.length,
      weekKey
    });
  });
