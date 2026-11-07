import { z } from "zod";

import {
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  type discordNotifications,
  type OutboxKind,
  type OutboxStatus
} from "../schema.ts";
import type { ClaimLease } from "../../time/lease.ts";
import { parseOutboxOwner, type OutboxOwner } from "./outbox.owner.ts";

// invariant: worker が新規投稿 payload を rehydrate する際の schema。
//   既存 message の編集は DB 正本からの best-effort 経路であり outbox へ混在させない。
const OUTBOX_PAYLOAD_TARGETS = ["askMessageId", "postponeMessageId"] as const;

const outboxPayloadSchema = z.object({
  kind: z.literal("send_message"),
  renderer: z.string(),
  channelId: z.string(),
  target: z.enum(OUTBOX_PAYLOAD_TARGETS).optional(),
  extra: z.record(z.string(), z.unknown()).optional()
});

export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

export type OutboxEntry = OutboxOwner & {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly payload: OutboxPayload;
  readonly dedupeKey: string;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly claimExpiresAt: Date | null;
  readonly claimToken: string | null;
  /** Present only on claims returned by the delivery acquisition boundary. */
  readonly lease?: ClaimLease;
  readonly nextAttemptAt: Date;
  readonly deliveredAt: Date | null;
  readonly deliveredMessageId: string | null;
  readonly aggregateRevision: number;
  readonly ordinal: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type EnqueueOutboxInput = OutboxOwner & {
  readonly kind: OutboxKind;
  readonly payload: OutboxPayload;
  readonly dedupeKey: string;
  readonly aggregateRevision: number;
  readonly ordinal: number;
};

export type OutboxDiagnostic = Pick<OutboxEntry, "id" | "sessionId" | "weekKey" | "status" | "attemptCount" | "createdAt" | "dedupeKey">;

export interface EnqueueResult {
  readonly id: string;
  readonly skipped: boolean;
}

export type AttendanceNotificationRow = Pick<typeof discordNotifications.$inferSelect,
  "id" | "kind" | "payload" | "dedupeKey" | "status" | "attemptCount" | "lastError" |
  "claimExpiresAt" | "claimToken" | "nextAttemptAt" | "deliveredAt" | "createdAt" | "updatedAt"
> & {
  readonly sessionId: string | null;
  readonly weekKey: string | null;
  readonly aggregateRevision: number;
  readonly ordinal: number;
  readonly deliveredMessageId: string | null;
};

/** Invalid persisted data is an expected item-level failure; programming errors still propagate. */
export const parseOutboxRow = (row: AttendanceNotificationRow): OutboxEntry | undefined => {
  const owner = parseOutboxOwner(row);
  const kind = OUTBOX_KINDS.find(value => value === row.kind);
  const status = OUTBOX_STATUSES.find(value => value === row.status);
  if (!owner || !kind || !status) { return undefined; }
  const payload = outboxPayloadSchema.safeParse(row.payload);
  if (!payload.success) { return undefined; }
  return {
    ...owner,
    id: row.id,
    kind,
    payload: payload.data,
    dedupeKey: row.dedupeKey,
    status,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    claimExpiresAt: row.claimExpiresAt,
    claimToken: row.claimToken,
    nextAttemptAt: row.nextAttemptAt,
    deliveredAt: row.deliveredAt,
    deliveredMessageId: row.deliveredMessageId,
    aggregateRevision: row.aggregateRevision,
    ordinal: row.ordinal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
};
