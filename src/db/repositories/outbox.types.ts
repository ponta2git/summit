import { z } from "zod";

import {
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  type discordOutbox,
  type OutboxKind,
  type OutboxStatus
} from "../schema.js";
import { assertEnum } from "../rows.js";

// invariant: worker が payload を rehydrate する際の schema。
//   `kind="send_message"` は新規投稿、`kind="edit_message"` は既存 message の編集。
//   `target` は配送成功時に sessions の対応列へ書き戻す対象。
export const OUTBOX_PAYLOAD_TARGETS = ["askMessageId", "postponeMessageId"] as const;
export type OutboxPayloadTarget = (typeof OUTBOX_PAYLOAD_TARGETS)[number];

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

const outboxEditMessagePayloadSchema = outboxPayloadBaseSchema.extend({
  kind: z.literal("edit_message"),
  renderer: z.string(),
  messageId: z.string()
});

export const outboxPayloadSchema = z.discriminatedUnion("kind", [
  outboxSendMessagePayloadSchema,
  outboxEditMessagePayloadSchema
]);

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
  readonly nextAttemptAt: Date;
  readonly deliveredAt: Date | null;
  readonly deliveredMessageId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EnqueueOutboxInput {
  readonly kind: OutboxKind;
  readonly sessionId: string;
  readonly payload: OutboxPayload;
  readonly dedupeKey: string;
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
  nextAttemptAt: row.nextAttemptAt,
  deliveredAt: row.deliveredAt,
  deliveredMessageId: row.deliveredMessageId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});
