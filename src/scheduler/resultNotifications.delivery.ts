import type { Client } from "discord.js";
import type { Logger } from "pino";
import * as Effect from "effect/Effect";
import type { ClaimedResultNotification, ResultDeliveryContext, ResultNotificationsPort } from "../db/ports.resultNotifications.ts";
import { OUTBOX_BACKOFF_MS_SEQUENCE, OUTBOX_CLAIM_DURATION_MS, RESULT_NOTIFICATION_HEARTBEAT_MS, RESULT_NOTIFICATION_SEND_TIMEOUT_MS } from "../config.ts";
import { DatabaseError } from "../errors/index.ts";
import { getTextChannel } from "../discord/shared/channels.ts";
import { validateStoredNotification } from "../domain/resultNotificationPayload.ts";
import type { ResultDeliveryError } from "../domain/notification.ts";
import { planResultNotification } from "../features/result-notifications/render.ts";
import { promiseCall, runPromiseBoundary, settledCall } from "../runtime/effect.ts";
import { addMs, type Clock } from "../time/index.ts";
import { withClaimHeartbeat } from "./claimHeartbeat.ts";
import { notificationNonce } from "./deliveryNonce.ts";

class DeliveryTimeout extends Error {}
// invariant: timeout は待機だけを打ち切る。SDK の送信結果は不明として nonce / CAS で回復する。
const boundedSend = <T>(send: () => Promise<T>): Effect.Effect<T, unknown> =>
  promiseCall(send).pipe(Effect.timeoutFail({
    duration: RESULT_NOTIFICATION_SEND_TIMEOUT_MS,
    onTimeout: () => new DeliveryTimeout()
  }));

const databaseCall = <T>(call: () => Promise<T>): Effect.Effect<T, DatabaseError> =>
  settledCall(call).pipe(Effect.mapError(cause =>
    new DatabaseError("Result notification persistence failed.", { cause })));

const classifyFailure = (error: unknown, sending: boolean): { code: ResultDeliveryError; retry: boolean } => {
  if (error instanceof DatabaseError) {
    return { code: sending ? "delivery_uncertain" : "delivery_failed", retry: true };
  }
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (status === 400) { return { code: "invalid_payload", retry: false }; }
  if (status === 401 || status === 403 || status === 404) { return { code: "delivery_failed", retry: false }; }
  if (status === 429) { return { code: "discord_rate_limited", retry: true }; }
  return { code: sending ? "delivery_uncertain" : "discord_unavailable", retry: true };
};

export interface ResultDeliveryDeps {
  readonly client: Client;
  readonly port: ResultNotificationsPort;
  readonly clock: Clock;
  readonly context: ResultDeliveryContext;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
  readonly isStopping: () => boolean;
}

/** A notification owns ordered parts; no database transaction spans Discord I/O. */
export const deliverResultNotification = async (deps: ResultDeliveryDeps, entry: ClaimedResultNotification): Promise<void> => {
  const { port, clock, logger } = deps;
  const fail = async (code: ResultDeliveryError, retry: boolean): Promise<void> => {
    const now = clock.now();
    const delay = OUTBOX_BACKOFF_MS_SEQUENCE[Math.min(Math.max(0, entry.attemptCount - 1), OUTBOX_BACKOFF_MS_SEQUENCE.length - 1)] ?? 60_000;
    const next = retry && entry.attemptCount < entry.maxAttempts ? addMs(now, delay) : null;
    const changed = await port.fail(entry.id, entry.claimToken, code, next, now);
    logger.warn({ event: changed ? "result_notification.delivery_failed" : "result_notification.claim_lost",
      notificationId: entry.id, kind: entry.kind, attempt: entry.attemptCount, code, nextAttemptAt: next?.toISOString() ?? null });
  };
  let sending = false;
  try {
    let rendered;
    const context = entry.partCount === 0 ? deps.context : entry.deliveryContext;
    if (!context || (entry.rendererVersion !== null && entry.rendererVersion !== (entry.kind === "ocr_completed" ? 2 : 1))) {
      await fail("unsupported_renderer", false); return;
    }
    try {
      rendered = planResultNotification(validateStoredNotification(entry.payload), context.webOrigin, entry.rendererVersion ?? (entry.kind === "ocr_completed" ? 2 : 1));
    } catch { await fail("invalid_payload", false); return; }
    if (entry.partCount > 0 && rendered.partCount !== entry.partCount) {
      await fail("unsupported_renderer", false); return;
    }
    if (deps.isStopping()) { return; }
    const notification = rendered;
    await runPromiseBoundary(withClaimHeartbeat({
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
      if (isClaimLost() || deps.isStopping()) { return; }
      const channel = yield* boundedSend(() => getTextChannel(deps.client, context.channelId));
      const delivered = new Set(entry.parts.filter(part => part.status === "DELIVERED").map(part => part.partNo));
      let nextPartNo = 0;
      for (const body of notification.parts()) {
        const partNo = nextPartNo++;
        if (delivered.has(partNo)) { continue; }
        if (isClaimLost() || deps.isStopping()) { return; }
        if (!(yield* databaseCall(() => port.begin(entry.id, partNo, entry.claimToken, clock.now())))) { return; }
        if (isClaimLost() || deps.isStopping()) { return; }
        sending = true;
        const message = yield* boundedSend(() => channel.send({ ...body, nonce: notificationNonce(entry.id, partNo), enforceNonce: true }));
        // Cancellation may preserve this already-started part. Always try to record
        // its message ID; the port fences ownership again even if the heartbeat failed.
        const changed = yield* databaseCall(() => port.complete(entry.id, partNo, entry.claimToken, message.id, clock.now()));
        logger.info({ event: changed ? "result_notification.part_delivered" : "result_notification.claim_lost_after_send",
          notificationId: entry.id, kind: entry.kind, partNo, messageId: message.id, attempt: entry.attemptCount });
        if (!changed) { return; }
        sending = false;
      }
    })));
  } catch (error: unknown) {
    const failure = classifyFailure(error, sending);
    try { await fail(failure.code, failure.retry); }
    catch { logger.error({ event: "result_notification.finalization_uncertain", notificationId: entry.id }); }
  }
};
