import * as Effect from "effect/Effect";
import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.ts";
import {
  OUTBOX_BACKOFF_MS_SEQUENCE,
  OUTBOX_CLAIM_DURATION_MS,
  OUTBOX_HEARTBEAT_MS,
  OUTBOX_MAX_ATTEMPTS
} from "../../config.ts";
import type { OutboxEntry } from "../../db/ports.ts";
import { AppError } from "../../errors/index.ts";
import { logger } from "../../logger.ts";
import { getTextChannel } from "../../discord/shared/channels.ts";
import type { prepareAttendanceNotification } from "./definitions/attendance.ts";
import type { SinglePostInput, SinglePostStrategy } from "./strategies/singlePost.ts";
import type { DeliveryExecution } from "./capacity.ts";
import { addMs } from "../../time/index.ts";
import { catchExpectedError, settledCall } from "../../runtime/effect.ts";
import { withClaimHeartbeat } from "./claimHeartbeat.ts";

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

type OutboxDeliveryMetadata = Pick<OutboxEntry, "id" | "sessionId" | "dedupeKey" | "attemptCount">;
type AttendanceNotification = Effect.Success<ReturnType<typeof prepareAttendanceNotification>>;

export interface AttendanceDeliveryAdapters {
  readonly prepareNotification: typeof prepareAttendanceNotification;
  readonly strategy: SinglePostStrategy;
}

type PreparedDelivery = SinglePostInput<boolean | undefined>;

const prepareDelivery = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  entry: OutboxDeliveryMetadata,
  claimToken: string,
  notification: AttendanceNotification,
  isStopping: () => boolean
): Effect.fn.Return<PreparedDelivery | undefined, unknown> {
  if (isStopping()) { return; }
  if (notification === undefined) {
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

  const channel = yield* settledCall(() => getTextChannel(client, notification.channelId));
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
  return { body: notification.body, definition: notification.definition, channel };
});

const recordDeliveryFailure = Effect.fnUntraced(function* (
  ctx: AppContext,
  entry: OutboxDeliveryMetadata,
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

const deliverClaimedEntry = (
  client: Client,
  ctx: AppContext,
  entry: OutboxDeliveryMetadata,
  claimToken: string,
  render: Effect.Effect<AttendanceNotification, unknown>,
  isStopping: () => boolean,
  strategy: SinglePostStrategy
): Effect.Effect<void, unknown> => {
  const preparation = Effect.suspend(() => isStopping() ? Effect.succeed(undefined) : render).pipe(
    Effect.flatMap(notification => prepareDelivery(client, ctx, entry, claimToken, notification, isStopping))
  );
  return catchExpectedError(preparation,
    error => recordDeliveryFailure(ctx, entry, claimToken, error).pipe(Effect.as(undefined))).pipe(
    Effect.flatMap(prepared => {
      if (prepared === undefined || isStopping()) { return Effect.void; }
      // invariant: send 開始後は中断要求があっても成功保存または失敗確定まで所有する。
      return catchExpectedError(strategy(prepared, { isStopping }),
        error => recordDeliveryFailure(ctx, entry, claimToken, error)).pipe(Effect.uninterruptible);
    })
  );
};

export const deliverOutboxEntry = (
  client: Client,
  ctx: AppContext,
  entry: OutboxEntry,
  execution: DeliveryExecution,
  adapters: AttendanceDeliveryAdapters
): Effect.Effect<void, unknown> => {
  const { claimToken } = entry;
  const metadata: OutboxDeliveryMetadata = {
    id: entry.id, sessionId: entry.sessionId, dedupeKey: entry.dedupeKey, attemptCount: entry.attemptCount
  };
  if (!claimToken) {
    return Effect.sync(() => {
      logger.error({ event: "outbox.missing_claim_token", outboxId: metadata.id, sessionId: metadata.sessionId },
        "Outbox worker received an unfenced claim.");
    });
  }
  // The reusable render Effect owns its input; lease, failure and post-render work use metadata only.
  const render = Effect.suspend(() => adapters.prepareNotification(ctx, entry, claimToken));
  return withClaimHeartbeat({
    intervalMs: OUTBOX_HEARTBEAT_MS,
    renew: () => ctx.ports.outbox.renewClaim(metadata.id, {
      claimToken, now: ctx.clock.now(), claimDurationMs: OUTBOX_CLAIM_DURATION_MS
    }),
    onLost: reason => {
      logger.warn({ event: reason === "uncertain" ? "outbox.lease_uncertain" : "outbox.claim_lost",
        outboxId: metadata.id, sessionId: metadata.sessionId });
    }
  }, isClaimLost => deliverClaimedEntry(client, ctx, metadata, claimToken, render,
    () => execution.isStopping() || isClaimLost(), adapters.strategy));
};
