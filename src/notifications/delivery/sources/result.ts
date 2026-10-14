import type * as Effect from "effect/Effect";
import type { ResultNotificationKind } from "@momo/db";
import type { ClaimedResultNotification, ResultNotificationsPort } from "../../../db/ports.resultNotifications.ts";
import { OUTBOX_CLAIM_DURATION_MS } from "../../../config.ts";
import { fromDatabaseCall } from "../../../errors/effect.ts";
import type { DatabaseError } from "../../../errors/index.ts";
import type { Clock } from "../../../time/index.ts";
import type { DeliveryBudget } from "../capacity.ts";
import { deliveryLanes } from "../lanes.ts";

export interface ResultDeliverySource {
  claim(budget: DeliveryBudget): Effect.Effect<readonly ClaimedResultNotification[], DatabaseError>;
  nextDispatchAt(activeIds: readonly string[]): Effect.Effect<Date | null, DatabaseError>;
  wake(reason: string): void;
  claimed(entry: ClaimedResultNotification): () => boolean;
}

/** Own result selection and handoff fairness, independently of capacity accounting. */
export const createResultDeliverySource = (port: ResultNotificationsPort, clock: Clock): ResultDeliverySource => {
  let preferredKind: ResultNotificationKind = "ocr_completed";
  let wakeGeneration = 0;
  const claim = (budget: DeliveryBudget): Effect.Effect<readonly ClaimedResultNotification[], DatabaseError> => fromDatabaseCall(() => port.claim({
    limit: budget.slots, now: clock.now(), claimDurationMs: OUTBOX_CLAIM_DURATION_MS,
    excludeIds: budget.activeIds, payloadBudgetBytes: budget.payloadBytes,
    allowOversizedPayload: budget.allowOversized, preferredKind
  }), "Failed to claim result notifications.");
  const nextDispatchAt = (activeIds: readonly string[]): Effect.Effect<Date | null, DatabaseError> =>
    fromDatabaseCall(() => port.getNextDispatchAt(activeIds), "Failed to read result dispatch time.");
  return {
    claim,
    nextDispatchAt,
    wake: reason => { if (reason !== "delivery_finished") { wakeGeneration += 1; } },
    claimed: entry => {
      preferredKind = entry.kind === "ocr_completed" ? "analysis_completed" : "ocr_completed";
      const oversized = entry.payloadBytes > deliveryLanes.results.payloadBytes;
      let checkedGeneration = -1;
      return () => {
        if (oversized || checkedGeneration === wakeGeneration) { return false; }
        checkedGeneration = wakeGeneration;
        return true;
      };
    }
  };
};
