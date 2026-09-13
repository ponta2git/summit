import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../appContext.ts";
import type { SessionRow } from "../db/rows.ts";
import type { AppError } from "../errors/index.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
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
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const keepCommittedCancellation = (messageKind: "ask" | "postpone") => (error: AppError) => {
      logger.warn({ event: "cancel_week.repaint_failed", sessionId: session.id, weekKey: session.weekKey, messageKind, error },
        "Cancellation is committed; a message could not be repainted.");
      return Effect.void;
    };
    yield* updateAskMessage(client, ctx, session).pipe(Effect.catchAll(keepCommittedCancellation("ask")));
    if (session.postponeMessageId) {
      yield* updatePostponeMessage(client, ctx, session).pipe(Effect.catchAll(keepCommittedCancellation("postpone")));
    }
  });

/**
 * Apply /cancel_week as one week-level transaction, then repaint affected messages.
 */
export const applyManualSkip = (
  client: Client,
  ctx: AppContext,
  params: { readonly invokerUserId: string; readonly expectedWeekKey: string }
): Effect.Effect<SkipWeekOutcome, AppError> =>
  Effect.gen(function* () {
    const now = ctx.clock.now();
    const weekKey = isoWeekKey(now);
    if (weekKey !== params.expectedWeekKey) {
      return { kind: "expired" as const };
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
      return { kind: "applied" as const, skippedCount: 0, weekKey };
    }
    if (outcome.kind === "already_closed") {
      logger.info(
        { weekKey, invokerUserId: params.invokerUserId },
        "Manual skip found only already-closed sessions."
      );
      return { kind: "applied" as const, skippedCount: 0, weekKey };
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
    return {
      kind: "applied" as const,
      skippedCount: outcome.skippedSessions.length,
      weekKey
    };
  });
