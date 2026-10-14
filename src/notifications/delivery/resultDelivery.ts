import type { Client, MessageCreateOptions } from "discord.js";
import type { Logger } from "pino";
import * as Effect from "effect/Effect";
import type { ResultNotificationsPort } from "../../db/ports.resultNotifications.ts";
import { OUTBOX_BACKOFF_MS_SEQUENCE, OUTBOX_CLAIM_DURATION_MS, RESULT_NOTIFICATION_HEARTBEAT_MS, RESULT_NOTIFICATION_SEND_TIMEOUT_MS } from "../../config.ts";
import { DatabaseError } from "../../errors/index.ts";
import { getTextChannel } from "../../discord/shared/channels.ts";
import { sendResultMessage } from "../../discord/shared/sendResultMessage.ts";
import type { ResultDeliveryError } from "../../domain/notification.ts";
import type { PreparedResultDelivery } from "./definitions/result.ts";
import type { ResumableStrategy } from "./strategies/resumable.ts";
import { catchExpectedError, promiseCall, settledCall } from "../../runtime/effect.ts";
import { addMs, type Clock } from "../../time/index.ts";
import { withClaimHeartbeat } from "./claimHeartbeat.ts";
import { notificationNonce } from "./deliveryNonce.ts";

class DiscordDeliveryFailure extends Error {
  readonly status: unknown;
  constructor(cause?: unknown) {
    super("Result notification Discord call failed.", { cause });
    this.status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : null;
  }
}
type DeliveryFailure = DatabaseError | DiscordDeliveryFailure;

// invariant: timeout は待機だけを打ち切る。SDK の送信結果は不明として nonce / CAS で回復する。
const boundedSend = <T>(send: () => Promise<T>): Effect.Effect<T, DiscordDeliveryFailure> =>
  promiseCall(send).pipe(Effect.mapError(cause => new DiscordDeliveryFailure(cause)), Effect.timeoutOrElse({
    duration: RESULT_NOTIFICATION_SEND_TIMEOUT_MS,
    orElse: () => Effect.fail(new DiscordDeliveryFailure())
  }));

const databaseCall = <T>(call: () => Promise<T>): Effect.Effect<T, DatabaseError> =>
  settledCall(call).pipe(Effect.mapError(cause =>
    new DatabaseError("Result notification persistence failed.", { cause })));

const classifyFailure = (error: DeliveryFailure, sending: boolean): { code: ResultDeliveryError; retry: boolean } => {
  if (error instanceof DatabaseError) {
    return { code: sending ? "delivery_uncertain" : "delivery_failed", retry: true };
  }
  if (error.status === 400) { return { code: "invalid_payload", retry: false }; }
  if (error.status === 401 || error.status === 403 || error.status === 404) { return { code: "delivery_failed", retry: false }; }
  if (error.status === 429) { return { code: "discord_rate_limited", retry: true }; }
  return { code: sending ? "delivery_uncertain" : "discord_unavailable", retry: true };
};

export interface ResultDeliveryDeps {
  readonly client: Client;
  readonly port: ResultNotificationsPort;
  readonly clock: Clock;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
  readonly isStopping: () => boolean;
  readonly strategy: ResumableStrategy;
  /** Consume a coalesced request to check for waiting work, only after a part is persisted. */
  readonly consumeYieldRequest?: () => boolean;
}

/** Compose one prepared delivery without crossing an Effect/Promise execution boundary. */
export const deliverPreparedResultNotification = (
  deps: ResultDeliveryDeps, prepared: PreparedResultDelivery
): Effect.Effect<void, DeliveryFailure> => Effect.suspend(() => {
  const { port, clock, logger } = deps;
  const entry = prepared.metadata;
  const fail = (code: ResultDeliveryError, retry: boolean): Effect.Effect<void, DatabaseError> => Effect.gen(function* () {
    const now = clock.now();
    const delay = OUTBOX_BACKOFF_MS_SEQUENCE[Math.min(Math.max(0, entry.attemptCount - 1), OUTBOX_BACKOFF_MS_SEQUENCE.length - 1)] ?? 60_000;
    const next = retry && entry.attemptCount < entry.maxAttempts ? addMs(now, delay) : null;
    const changed = yield* databaseCall(() => port.fail(entry.id, entry.claimToken, code, next, now));
    logger.warn({ event: changed ? "result_notification.delivery_failed" : "result_notification.claim_lost",
      notificationId: entry.id, kind: entry.kind, attempt: entry.attemptCount, code, nextAttemptAt: next?.toISOString() ?? null });
  });
  const finalizeFailure = (code: ResultDeliveryError, retry: boolean): Effect.Effect<void, DatabaseError> =>
    catchExpectedError(fail(code, retry), () => Effect.sync(() => {
      logger.error({ event: "result_notification.finalization_uncertain", notificationId: entry.id });
    }));
  if (prepared.strategy === "rejected") { return finalizeFailure(prepared.error, false); }
  if (deps.isStopping()) { return Effect.void; }
  const { notification, context, deliveredPartNos } = prepared;
  let sending = false;
  return catchExpectedError(withClaimHeartbeat({
    intervalMs: RESULT_NOTIFICATION_HEARTBEAT_MS,
    renew: () => port.renew(entry.id, entry.claimToken, clock.now(), OUTBOX_CLAIM_DURATION_MS),
    onLost: reason => { logger.warn({
      event: reason === "uncertain" ? "result_notification.lease_uncertain" : "result_notification.claim_lost",
      notificationId: entry.id
    }); }
  }, isClaimLost => Effect.gen(function* () {
    if (!(yield* databaseCall(() => port.plan(entry.id, entry.claimToken, {
      count: notification.partCount, rendererVersion: notification.rendererVersion, context, now: clock.now()
    })))) { return; }
    const shouldStop = (): boolean => isClaimLost() || deps.isStopping();
    if (shouldStop()) { return; }
    const channel = yield* boundedSend(() => getTextChannel(deps.client, context.channelId));
    yield* deps.strategy<MessageCreateOptions, DeliveryFailure>({
      parts: notification.parts, partCount: notification.partCount, deliveredPartNos, shouldStop,
      begin: partNo => databaseCall(() => port.begin(entry.id, partNo, entry.claimToken, clock.now())),
      send: (partNo, body) => Effect.suspend(() => {
        sending = true;
        return boundedSend(() => sendResultMessage(channel, { ...body, nonce: notificationNonce(entry.id, partNo), enforceNonce: true }));
      }),
      complete: (partNo, messageId) => Effect.gen(function* () {
        const changed = yield* databaseCall(() => port.complete(entry.id, partNo, entry.claimToken, messageId, clock.now()));
        logger.info({ event: changed ? "result_notification.part_delivered" : "result_notification.claim_lost_after_send",
          notificationId: entry.id, kind: entry.kind, partNo, messageId, attempt: entry.attemptCount });
        if (changed) { sending = false; }
        return changed;
      }),
      consumeYieldRequest: () => deps.consumeYieldRequest?.() ?? false,
      yield: partNo => Effect.gen(function* () {
        const changed = yield* databaseCall(() => port.yield(entry.id, entry.claimToken, clock.now()));
        if (changed) { logger.info({ event: "result_notification.yielded", notificationId: entry.id, kind: entry.kind, partNo }); }
        return changed;
      })
    });
  })), error => {
    const failure = classifyFailure(error, sending);
    return finalizeFailure(failure.code, failure.retry);
  });
});
