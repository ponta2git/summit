import { z } from "zod";

import {
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  type discordOutbox,
  type OutboxKind,
  type OutboxStatus
} from "../schema.ts";
import { assertEnum } from "../rows.ts";

// invariant: worker が新規投稿 payload を rehydrate する際の schema。
//   既存 message の編集は DB 正本からの best-effort 経路であり outbox へ混在させない。
const OUTBOX_PAYLOAD_TARGETS = ["askMessageId", "postponeMessageId"] as const;

const outboxPayloadExtraSchema = z.record(z.string(), z.unknown());

const outboxPayloadBaseSchema = z.object({
  channelId: z.string(),
  target: z.enum(OUTBOX_PAYLOAD_TARGETS).optional(),
  extra: outboxPayloadExtraSchema.optional()
});

const outboxSendMessagePayloadSchema = outboxPayloadBaseSchema.extend({
  kind: z.literal("send_message"),
  renderer: z.string()
});

const outboxPayloadSchema = outboxSendMessagePayloadSchema;

export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

export interface OutboxEntry {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly sessionId: string;
  readonly payload: OutboxPayload;
  readonly dedupeKey: string;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly claimExpiresAt: Date | null;
  readonly claimToken: string | null;
  readonly nextAttemptAt: Date;
  readonly deliveredAt: Date | null;
  readonly deliveredMessageId: string | null;
  readonly aggregateRevision: number;
  readonly ordinal: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EnqueueOutboxInput {
  readonly kind: OutboxKind;
  readonly sessionId: string;
  readonly payload: OutboxPayload;
  readonly dedupeKey: string;
  readonly aggregateRevision: number;
  readonly ordinal: number;
}

export interface EnqueueResult {
  readonly id: string;
  readonly skipped: boolean;
}

export const mapOutboxRow = (row: typeof discordOutbox.$inferSelect): OutboxEntry => ({
  id: row.id,
  kind: assertEnum(OUTBOX_KINDS, row.kind, "outbox kind"),
  sessionId: row.sessionId,
  payload: outboxPayloadSchema.parse(row.payload),
  dedupeKey: row.dedupeKey,
  status: assertEnum(OUTBOX_STATUSES, row.status, "outbox status"),
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
});
