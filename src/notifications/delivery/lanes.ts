import { OUTBOX_WORKER_BATCH_LIMIT, RESULT_NOTIFICATION_CONCURRENCY, RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES } from "../../config.ts";

/** Operational capacity pools; notification selection belongs to each source. */
export const deliveryLanes = {
  attendance: { slots: OUTBOX_WORKER_BATCH_LIMIT },
  results: { slots: RESULT_NOTIFICATION_CONCURRENCY, payloadBytes: RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES }
} as const;
