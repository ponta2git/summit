import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import {
  OUTBOX_BACKOFF_MS_SEQUENCE,
  OUTBOX_CLAIM_DURATION_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_WORKER_BATCH_LIMIT
} from "../config.js";
import type { OutboxEntry } from "../db/ports.js";
import { DatabaseError, type AppError } from "../errors/index.js";
import { fromAppCall, fromDatabaseCall } from "../errors/result.js";
import { logger } from "../logger.js";
import { getTextChannel } from "../discord/shared/channels.js";
import {
  completeReminderDelivery
} from "../features/reminder/send.js";
import { addMs } from "../time/index.js";
import { renderOutboxPayload } from "./outboxRenderers.js";
import type { SchedulerResult } from "./scheduler.types.js";

/**
 * Compute next_attempt_at from the current attempt count via exponential backoff.
 *
 * @remarks
 * state: `attemptCount >= OUTBOX_MAX_ATTEMPTS` で `null` を返し dead letter (FAILED)。
 * `attemptCount` は claim で +1 された後の値。
 * @see ADR-0051
 */
export const computeOutboxBackoff = (
  attemptCount: number,
  now: Date
): Date | null => {
  if (attemptCount >= OUTBOX_MAX_ATTEMPTS) {
    return null;
  }
  const idx = Math.max(0, Math.min(attemptCount - 1, OUTBOX_BACKOFF_MS_SEQUENCE.length - 1));
  const delayMs = OUTBOX_BACKOFF_MS_SEQUENCE[idx] ?? OUTBOX_BACKOFF_MS_SEQUENCE.at(-1) ?? 60_000;
  return addMs(now, delayMs);
};

const deliverOne = async (
  client: Client,
  ctx: AppContext,
  entry: OutboxEntry
): Promise<void> => {
  const now = ctx.clock.now();
  const payload = entry.payload;
  const claimToken = entry.claimToken;
  if (!claimToken) {
    logger.error(
      {
        event: "outbox.missing_claim_token",
        outboxId: entry.id,
        sessionId: entry.sessionId
      },
      "Outbox worker received an unfenced claim."
    );
    return;
  }

  try {
    const body = await renderOutboxPayload(ctx, entry);
    if (body === undefined) {
      // state: 未対応 renderer / state mismatch は dead letter (握り潰し禁止)。
      const marked = await ctx.ports.outbox.markFailed(entry.id, {
        error: `Unsupported outbox payload: kind=${payload.kind}, renderer=${payload.renderer}`,
        claimToken,
        now,
        nextAttemptAt: null
      });
      if (!marked) {
        logger.error(
          { event: "outbox.claim_lost", outboxId: entry.id, sessionId: entry.sessionId },
          "Outbox worker lost claim while dead-lettering unsupported payload."
        );
        return;
      }
      logger.error(
        {
          event: "outbox.unsupported_payload",
          outboxId: entry.id,
          sessionId: entry.sessionId,
          kind: payload.kind,
          renderer: payload.renderer,
          dedupeKey: entry.dedupeKey
        },
        "Outbox worker: unsupported payload; moved to FAILED."
      );
      return;
    }

    const channel = await getTextChannel(client, payload.channelId);
    const sent = await channel.send(body);
    if (payload.renderer === "reminder") {
      const completed = await completeReminderDelivery(
        ctx,
        entry.sessionId,
        ctx.clock.now()
      );
      if (!completed) {
        throw new Error("Reminder delivered but Session/HeldEvent completion failed");
      }
    }
    // race: claim expiry 後は旧・新 worker が Discord 受理まで到達し得る。CAS-on-NULL で
    // canonical message を先勝ちにし、outbox の確定自体は claimToken で fence する。
    let backfillResult: boolean | undefined;
    if (payload.target === "askMessageId") {
      backfillResult = await ctx.ports.sessions.backfillAskMessageId(entry.sessionId, sent.id);
    } else if (payload.target === "postponeMessageId") {
      backfillResult = await ctx.ports.sessions.backfillPostponeMessageId(
        entry.sessionId,
        sent.id
      );
    }
    const marked = await ctx.ports.outbox.markDelivered(entry.id, {
      claimToken,
      deliveredMessageId: sent.id,
      now: ctx.clock.now()
    });
    if (!marked) {
      logger.error(
        {
          event: "outbox.claim_lost_after_send",
          outboxId: entry.id,
          sessionId: entry.sessionId,
          messageId: sent.id
        },
        "Outbox worker lost claim after Discord accepted the message."
      );
      return;
    }
    if (backfillResult === false) {
      logger.warn(
        {
          event: "outbox.backfill_skipped",
          outboxId: entry.id,
          sessionId: entry.sessionId,
          dedupeKey: entry.dedupeKey,
          target: payload.target,
          messageId: sent.id
        },
        "Outbox worker: target column already set; skipped back-fill."
      );
    }
    logger.info(
      {
        event: "outbox.delivered",
        outboxId: entry.id,
        sessionId: entry.sessionId,
        dedupeKey: entry.dedupeKey,
        messageId: sent.id,
        attempt: entry.attemptCount
      },
      "Outbox worker: delivered message."
    );
  } catch (error: unknown) {
    const failedNow = ctx.clock.now();
    const nextAttemptAt = computeOutboxBackoff(entry.attemptCount, failedNow);
    const message = error instanceof Error ? error.message : String(error);
    const marked = await ctx.ports.outbox.markFailed(entry.id, {
      error: message,
      claimToken,
      now: failedNow,
      nextAttemptAt
    });
    if (!marked) {
      logger.error(
        {
          event: "outbox.claim_lost",
          outboxId: entry.id,
          sessionId: entry.sessionId,
          error: message
        },
        "Outbox worker lost claim while recording delivery failure."
      );
      return;
    }
    logger.warn(
      {
        event: nextAttemptAt === null ? "outbox.dead_letter" : "outbox.retry_scheduled",
        outboxId: entry.id,
        sessionId: entry.sessionId,
        dedupeKey: entry.dedupeKey,
        attempt: entry.attemptCount,
        nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
        error: message
      },
      "Outbox worker: send failed."
    );
  }
};

/**
 * Claim a batch of PENDING outbox entries and deliver each.
 *
 * @remarks
 * idempotent: 各 entry は独立の try/catch で隔離。全体例外は呼び出し側 (`runTickSafely`) が閉じ込める。
 * @see ADR-0051
 */
export const runOutboxWorkerTick = (
  client: Client,
  ctx: AppContext
): SchedulerResult<{ readonly claimed: number }> => {
  const now = ctx.clock.now();
  return fromDatabaseCall(
    () => ctx.ports.outbox.claimNextBatch({
      limit: OUTBOX_WORKER_BATCH_LIMIT,
      now,
      claimDurationMs: OUTBOX_CLAIM_DURATION_MS
    }),
    "Failed to claim outbox batch."
  ).andThen((batch) => {
    if (batch.length === 0) {
      return fromAppCall(
        async () => ({ claimed: 0 }),
        (cause: unknown): AppError => new DatabaseError("Unexpected empty outbox batch failure.", { cause })
      );
    }
    // race: entry 単位の DB CAS と try/catch で隔離済みなので、batch は並列配送して claim 期限切れを避ける。
    return fromAppCall(
      () => Promise.all(batch.map((entry) => deliverOne(client, ctx, entry))).then(() => ({ claimed: batch.length })),
      (cause: unknown): AppError => new DatabaseError("Failed to finalize outbox delivery batch.", { cause })
    );
  });
};
