import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { Client, MessageCreateOptions } from "discord.js";

import type { AppContext } from "../appContext.ts";
import {
  OUTBOX_BACKOFF_MS_SEQUENCE,
  OUTBOX_CLAIM_DURATION_MS,
  OUTBOX_HEARTBEAT_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_WORKER_BATCH_LIMIT
} from "../config.ts";
import type { OutboxEntry } from "../db/ports.ts";
import { AppError, InvariantViolationError } from "../errors/index.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
import { logger } from "../logger.ts";
import { getTextChannel } from "../discord/shared/channels.ts";
import {
  completeReminderDelivery
} from "../features/reminder/send.ts";
import { addMs } from "../time/index.ts";
import { errorFromCause } from "../runtime/cause.ts";
import { catchExpectedError, settledCall } from "../runtime/effect.ts";
import { withClaimHeartbeat } from "./claimHeartbeat.ts";
import { notificationNonce } from "./deliveryNonce.ts";
import { renderOutboxPayload } from "./outboxRenderers.ts";

/**
 * Compute next_attempt_at from the current attempt count via exponential backoff.
 *
 * @remarks
 * state: `attemptCount >= OUTBOX_MAX_ATTEMPTS` で `null` を返し dead letter (FAILED)。
 * `attemptCount` は claim で +1 された後の値。
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

interface PreparedDelivery {
  readonly body: MessageCreateOptions;
  readonly channel: Awaited<ReturnType<typeof getTextChannel>>;
}

const prepareDelivery = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  entry: OutboxEntry,
  claimToken: string,
  isStopping: () => boolean
): Effect.fn.Return<PreparedDelivery | undefined, unknown> {
  const payload = entry.payload;
  if (isStopping()) { return; }
  const body = yield* renderOutboxPayload(ctx, entry);
  if (isStopping()) { return; }
  if (body === undefined) {
    // state: 未対応 renderer / state mismatch は dead letter (握り潰し禁止)。
    const marked = yield* settledCall(() => ctx.ports.outbox.markFailed(entry.id, {
      error: "Unsupported outbox payload.",
      claimToken,
      now: ctx.clock.now(),
      nextAttemptAt: null
    }));
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
        dedupeKey: entry.dedupeKey
      },
      "Outbox worker: unsupported payload; moved to FAILED."
    );
    return;
  }

  const channel = yield* settledCall(() => getTextChannel(client, payload.channelId));
  if (isStopping()) { return; }
  const canSend = yield* settledCall(() => ctx.ports.outbox.beginDelivery(entry.id, { claimToken, now: ctx.clock.now() }));
  if (!canSend) {
    logger.info(
      { event: "outbox.send_not_started", outboxId: entry.id },
      "Notification was cancelled or its claim expired before send."
    );
    return;
  }
  if (isStopping()) { return; }
  return { body, channel };
});

const sendAndFinalize = Effect.fnUntraced(function* (
  ctx: AppContext,
  entry: OutboxEntry,
  claimToken: string,
  { body, channel }: PreparedDelivery,
  isStopping: () => boolean
): Effect.fn.Return<void, unknown> {
  const payload = entry.payload;
  const sent = yield* settledCall(() => isStopping() ? Promise.resolve(undefined) :
    channel.send({ ...body, nonce: notificationNonce(entry.id, 0), enforceNonce: true }));
  if (!sent) { return; }
  if (payload.renderer === "reminder") {
    const completed = yield* settledCall(() => completeReminderDelivery(ctx, entry.sessionId, ctx.clock.now()));
    if (!completed) {
      return yield* Effect.fail(new Error("Reminder delivered but Session/HeldEvent completion failed"));
    }
  }
  // race: claim expiry 後は旧・新 worker が Discord 受理まで到達し得る。CAS-on-NULL で
  // canonical message を先勝ちにし、outbox の確定自体は claimToken で fence する。
  let backfillResult: boolean | undefined;
  if (payload.target === "askMessageId") {
    backfillResult = yield* settledCall(() => ctx.ports.sessions.backfillAskMessageId(entry.sessionId, sent.id));
  } else if (payload.target === "postponeMessageId") {
    backfillResult = yield* settledCall(() => ctx.ports.sessions.backfillPostponeMessageId(entry.sessionId, sent.id));
  }
  const marked = yield* settledCall(() => ctx.ports.outbox.markDelivered(entry.id, {
    claimToken,
    deliveredMessageId: sent.id,
    now: ctx.clock.now()
  }));
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
});

const recordDeliveryFailure = Effect.fnUntraced(function* (
  ctx: AppContext,
  entry: OutboxEntry,
  claimToken: string,
  error: unknown
): Effect.fn.Return<void, unknown> {
  const failedNow = ctx.clock.now();
  const nextAttemptAt = computeOutboxBackoff(entry.attemptCount, failedNow);
  // redact: 外部例外のmessageにはtokenや接続情報が含まれるため、DBにも固定診断だけを保存する。
  const message = error instanceof AppError ? `Outbox delivery failed (${error.code}).` : "Outbox delivery failed.";
  const marked = yield* settledCall(() => ctx.ports.outbox.markFailed(entry.id, {
    error: message,
    claimToken,
    now: failedNow,
    nextAttemptAt
  }));
  if (!marked) {
    logger.error(
      {
        event: "outbox.claim_lost",
        outboxId: entry.id,
        sessionId: entry.sessionId,
        error,
        failureSummary: message
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
      error,
      failureSummary: message
    },
    "Outbox worker: send failed."
  );
}, Effect.uninterruptible);

const deliverClaimedEntry = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  entry: OutboxEntry,
  claimToken: string,
  isStopping: () => boolean
): Effect.fn.Return<void, unknown> {
  const prepared = yield* catchExpectedError(prepareDelivery(client, ctx, entry, claimToken, isStopping),
    error => recordDeliveryFailure(ctx, entry, claimToken, error).pipe(Effect.as(undefined)));
  if (prepared === undefined || isStopping()) { return; }
  // invariant: send 開始後は中断要求があっても成功保存または失敗確定まで所有する。
  yield* catchExpectedError(sendAndFinalize(ctx, entry, claimToken, prepared, isStopping),
    error => recordDeliveryFailure(ctx, entry, claimToken, error)).pipe(Effect.uninterruptible);
});

const deliverOne = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  entry: OutboxEntry,
  isStopping: () => boolean
): Effect.fn.Return<void, unknown> {
  const claimToken = entry.claimToken;
  if (!claimToken) {
    logger.error({ event: "outbox.missing_claim_token", outboxId: entry.id, sessionId: entry.sessionId },
      "Outbox worker received an unfenced claim.");
    return;
  }
  yield* withClaimHeartbeat({
    intervalMs: OUTBOX_HEARTBEAT_MS,
    renew: () => ctx.ports.outbox.renewClaim(entry.id, {
      claimToken, now: ctx.clock.now(), claimDurationMs: OUTBOX_CLAIM_DURATION_MS
    }),
    onLost: reason => {
      logger.warn({ event: reason === "uncertain" ? "outbox.lease_uncertain" : "outbox.claim_lost",
        outboxId: entry.id, sessionId: entry.sessionId });
    }
  }, isClaimLost => deliverClaimedEntry(client, ctx, entry, claimToken, () => isStopping() || isClaimLost()));
});

/**
 * Claim a batch of PENDING outbox entries and deliver each.
 *
 * @remarks
 * idempotent: 各 entry の Exit を集計して隔離。全体例外は呼び出し側 (`runEffectTickSafely`) が閉じ込める。
 */
export const runOutboxWorkerTick = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  isStopping: () => boolean = () => false
): Effect.fn.Return<{ readonly claimed: number }, unknown> {
  if (isStopping()) { return { claimed: 0 }; }
  const now = ctx.clock.now();
  const batch = yield* fromDatabaseCall(
    () => ctx.ports.outbox.claimNextBatch({
      limit: OUTBOX_WORKER_BATCH_LIMIT,
      now,
      claimDurationMs: OUTBOX_CLAIM_DURATION_MS
    }),
    "Failed to claim outbox batch."
  );
  // race: Fail / Die を含め全配送と heartbeat の settlement を待ち、入力順で失敗を選ぶ。
  const results = yield* Effect.forEach(batch, entry => Effect.exit(deliverOne(client, ctx, entry, isStopping)), {
    concurrency: OUTBOX_WORKER_BATCH_LIMIT
  });
  const interrupted = results.find(exit => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
  if (interrupted && Exit.isFailure(interrupted)) { return yield* Effect.failCause(interrupted.cause); }
  const failed = results.find(Exit.isFailure);
  if (failed) {
    return yield* Effect.fail(new InvariantViolationError("Failed to finalize outbox delivery.", {
      cause: errorFromCause(failed.cause)
    }));
  }
  return { claimed: batch.length };
}, Effect.catchCause(cause => {
  if (Cause.hasInterrupts(cause)) {
    return Effect.failCause(Cause.map(cause, error => error instanceof AppError ? error :
      new InvariantViolationError("Failed to finalize outbox delivery batch.", { cause: error })));
  }
  const error = errorFromCause(cause);
  return Effect.fail(error instanceof AppError ? error :
    new InvariantViolationError("Failed to finalize outbox delivery batch.", { cause: error }));
}));
