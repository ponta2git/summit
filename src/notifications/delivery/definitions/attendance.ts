import * as Effect from "effect/Effect";

import type { AppContext } from "../../../appContext.ts";
import type { OutboxEntry } from "../../../db/ports.ts";
import { completeReminderDelivery } from "../../../features/reminder/send.ts";
import { logger } from "../../../logger.ts";
import { settledCall } from "../../../runtime/effect.ts";
import { notificationNonce } from "../deliveryNonce.ts";
import {
  renderAskOutbox, renderCancelWeekOutbox, renderDecidedOutbox, renderPostponeOutbox,
  renderReminderOutbox, renderSettleOutbox, type OutboxRenderer
} from "../outboxRenderers.ts";
import type { SinglePostDefinition } from "../strategies/singlePost.ts";

/** Register rendering and notification-specific business confirmation together. */
export interface AttendanceNotificationDefinition {
  readonly render: OutboxRenderer;
  readonly confirmBusiness?: (ctx: AppContext, sessionId: string, messageId: string) => Effect.Effect<void, unknown>;
}
export type AttendanceNotificationRegistry = Readonly<Record<string, AttendanceNotificationDefinition>>;

export const attendanceDefinitions: AttendanceNotificationRegistry = {
  ask_body: { render: renderAskOutbox },
  settle_notice: { render: renderSettleOutbox },
  postpone_vote: { render: renderPostponeOutbox },
  decided_announcement: { render: renderDecidedOutbox },
  reminder: {
    render: renderReminderOutbox,
    confirmBusiness: Effect.fnUntraced(function* (ctx: AppContext, sessionId: string) {
      const completed = yield* settledCall(() => completeReminderDelivery(ctx, sessionId, ctx.clock.now()));
      if (!completed) {
        return yield* Effect.fail(new Error("Reminder delivered but Session/HeldEvent completion failed"));
      }
    })
  },
  cancel_week_notice: { render: renderCancelWeekOutbox }
};

const bindSinglePostDelivery = (
  ctx: AppContext,
  entry: OutboxEntry,
  claimToken: string,
  confirmBusiness: AttendanceNotificationDefinition["confirmBusiness"]
): SinglePostDefinition<boolean | undefined> => {
  const { id, sessionId, dedupeKey, attemptCount, payload: { target } } = entry;
  return {
    strategy: "singlePost",
    nonce: notificationNonce(id, 0),
    confirmBusiness: Effect.fnUntraced(function* (messageId: string) {
      if (confirmBusiness) {
        yield* confirmBusiness(ctx, sessionId, messageId);
      }
      // race: CAS-on-NULL keeps the first canonical message even after claim expiry;
      // the durable delivery acknowledgement remains fenced by claimToken.
      if (target === "askMessageId") {
        return yield* settledCall(() => ctx.ports.sessions.backfillAskMessageId(sessionId, messageId));
      }
      if (target === "postponeMessageId") {
        return yield* settledCall(() => ctx.ports.sessions.backfillPostponeMessageId(sessionId, messageId));
      }
      return undefined;
    }),
    confirmDelivery: Effect.fnUntraced(function* (messageId: string, backfillResult: boolean | undefined) {
      const marked = yield* settledCall(() => ctx.ports.outbox.markDelivered(id, {
        claimToken, deliveredMessageId: messageId, now: ctx.clock.now()
      }));
      if (!marked) {
        logger.error({ event: "outbox.claim_lost_after_send", outboxId: id, sessionId, messageId },
          "Outbox worker lost claim after Discord accepted the message.");
        return;
      }
      if (backfillResult === false) {
        logger.warn({ event: "outbox.backfill_skipped", outboxId: id, sessionId, dedupeKey, target, messageId },
          "Outbox worker: target column already set; skipped back-fill.");
      }
      logger.info({ event: "outbox.delivered", outboxId: id, sessionId, dedupeKey, messageId, attempt: attemptCount },
        "Outbox worker: delivered message.");
    })
  };
};

/** Render while the source payload is available, then retain only delivery metadata. */
export const prepareAttendanceNotification = Effect.fnUntraced(function* (
  ctx: AppContext,
  entry: OutboxEntry,
  claimToken: string,
  registry: AttendanceNotificationRegistry = attendanceDefinitions
) {
  const notification = Object.hasOwn(registry, entry.payload.renderer) ? registry[entry.payload.renderer] : undefined;
  if (!notification) { return undefined; }
  const body = yield* notification.render({ ctx, entry });
  if (body === undefined) { return undefined; }
  return {
    body,
    channelId: entry.payload.channelId,
    definition: bindSinglePostDelivery(ctx, entry, claimToken, notification.confirmBusiness)
  };
});
