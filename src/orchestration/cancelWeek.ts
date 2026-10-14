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
import { catchExpectedError } from "../runtime/effect.ts";
import {
  deadlineFor,
  formatCandidateDateIso,
  isoWeekKey
} from "../time/index.ts";
import { appConfig } from "../userConfig.ts";

type SkipWeekOutcome = { readonly kind: "expired" } | {
  readonly kind: "applied";
  readonly skippedCount: number;
  readonly weekKey: string;
};

const repaintSkippedSession = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Effect.fn.Return<void, AppError> {
  const keepCommittedCancellation = (messageKind: "ask" | "postpone") => (error: AppError) => {
    logger.warn({ event: "cancel_week.repaint_failed", sessionId: session.id, weekKey: session.weekKey, messageKind, error },
      "Cancellation is committed; a message could not be repainted.");
    return Effect.void;
  };
  yield* catchExpectedError(updateAskMessage(client, ctx, session), keepCommittedCancellation("ask"));
  if (session.postponeMessageId) {
    yield* catchExpectedError(updatePostponeMessage(client, ctx, session), keepCommittedCancellation("postpone"));
  }
});

/**
 * Apply /cancel_week as one week-level transaction, then repaint affected messages.
 */
export const applyManualSkip = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  params: { readonly invokerUserId: string; readonly expectedWeekKey: string }
): Effect.fn.Return<SkipWeekOutcome, AppError> {
  const now = ctx.clock.now();
  const weekKey = isoWeekKey(now);
  if (weekKey !== params.expectedWeekKey) {
    return { kind: "expired" as const };
  }
  const outcome = yield* fromDatabaseCall(
    () => ctx.ports.sessionCommands.cancelWeekAtomically({
      sentinelSessionId: randomUUID(),
      weekKey,
      candidateDateIso: formatCandidateDateIso(now),
      channelId: appConfig.discord.channelId,
      deadlineAt: deadlineFor(now),
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
