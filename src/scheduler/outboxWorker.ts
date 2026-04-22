// why: Discord send outbox worker (ADR-0035)。状態遷移と送信を非同期に分離し、
//   PENDING 行を claim → Discord に配送 → DELIVERED / FAILED に遷移させる。
//   tickRunner の最初の consumer として `runTickSafely` で例外を閉じ込める (ADR-0033 期の基盤)。

import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import {
  OUTBOX_BACKOFF_MS_SEQUENCE,
  OUTBOX_CLAIM_DURATION_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_WORKER_BATCH_LIMIT
} from "../config.js";
import type { OutboxEntry, OutboxPayload } from "../db/ports.js";
import { logger } from "../logger.js";
import { getTextChannel } from "../discord/shared/channels.js";

/**
 * Compute next_attempt_at from the current attempt count via exponential backoff.
 *
 * @remarks
 * `attemptCount` は既に claim で +1 された後の値。配列 index には `attemptCount - 1` を使う。
 * 末尾超過時は配列末尾値で頭打ちにして過度な再試行停止を避ける。
 */
export const computeOutboxBackoff = (
  attemptCount: number,
  now: Date
): Date | null => {
  if (attemptCount >= OUTBOX_MAX_ATTEMPTS) {
    // state: dead letter (FAILED)。/status の invariant 警告で運用者に通知される。
    return null;
  }
  const idx = Math.max(0, Math.min(attemptCount - 1, OUTBOX_BACKOFF_MS_SEQUENCE.length - 1));
  const delayMs = OUTBOX_BACKOFF_MS_SEQUENCE[idx] ?? OUTBOX_BACKOFF_MS_SEQUENCE.at(-1) ?? 60_000;
  return new Date(now.getTime() + delayMs);
};

/**
 * Render the Discord payload for an outbox entry.
 *
 * @remarks
 * 現段階 (ADR-0035 Phase 1) では text-only send_message のみを扱う。
 * 将来 renderer 種別を増やす場合はここで dispatch する (embeds/components)。
 * payload が `kind="send_message"` で `extra.content` (string) を持つ場合にそれを送信する。
 * それ以外は未対応として dead letter へ落とす (意図しない payload を worker が握り潰さない)。
 */
const renderPayloadText = (payload: OutboxPayload): string | undefined => {
  if (payload.kind !== "send_message") {return undefined;}
  const content = (payload.extra as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : undefined;
};

/**
 * Deliver a single claimed outbox entry.
 *
 * @remarks
 * source-of-truth: 送信成功時の Discord message id を `markDelivered` で永続化し、
 *   payload.target が指す Sessions 列 (askMessageId / postponeMessageId) を
 *   `backfillAskMessageId` / `backfillPostponeMessageId` (CAS-on-NULL) で back-fill する。
 * race: CAS-on-NULL により reconciler 再投稿と重なっても「先勝ち」が保証される (FR-M2)。
 *   既に非 NULL の場合は `outbox.backfill_skipped` を warn ログ化する。
 */
const deliverOne = async (
  client: Client,
  ctx: AppContext,
  entry: OutboxEntry
): Promise<void> => {
  const now = ctx.clock.now();
  const payload = entry.payload;

  const content = renderPayloadText(payload);
  if (content === undefined) {
    // state: 未対応 renderer は dead letter。握り潰しは禁止 (AGENTS.md rule)。
    await ctx.ports.outbox.markFailed(entry.id, {
      error: `Unsupported outbox payload: kind=${payload.kind}`,
      now,
      nextAttemptAt: null
    });
    logger.error(
      {
        event: "outbox.unsupported_payload",
        outboxId: entry.id,
        sessionId: entry.sessionId,
        kind: payload.kind,
        dedupeKey: entry.dedupeKey
      },
      "Outbox worker: unsupported payload kind; moved to FAILED."
    );
    return;
  }

  try {
    if (payload.kind === "send_message") {
      const channel = await getTextChannel(client, payload.channelId);
      const sent = await channel.send({ content });
      await ctx.ports.outbox.markDelivered(entry.id, {
        deliveredMessageId: sent.id,
        now: ctx.clock.now()
      });
      // source-of-truth: target が指定されていれば該当 Sessions 列に back-fill する。
      //   race: reconciler 再投稿がすでに別 messageId をセットしている場合は上書きしない (CAS-on-NULL)。
      //   @see ADR-0035 Consequences / FR-M2.
      let backfillResult: boolean | undefined;
      if (payload.target === "askMessageId") {
        backfillResult = await ctx.ports.sessions.backfillAskMessageId(entry.sessionId, sent.id);
      } else if (payload.target === "postponeMessageId") {
        backfillResult = await ctx.ports.sessions.backfillPostponeMessageId(
          entry.sessionId,
          sent.id
        );
      }
      if (backfillResult === false) {
        // state: 送信は成功したが DB 列はすでに非 NULL (reconciler/重複送信)。送った Discord message は
        //   reconciler の active probe 経路で検出されうるが、ここでは情報ログのみ残す。
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
    } else {
      // edit_message: 現フェーズでは未使用 (ADR-0035 Consequences)。安全側で dead letter。
      await ctx.ports.outbox.markFailed(entry.id, {
        error: "edit_message not yet supported by worker",
        now: ctx.clock.now(),
        nextAttemptAt: null
      });
    }
  } catch (error: unknown) {
    const failedNow = ctx.clock.now();
    const nextAttemptAt = computeOutboxBackoff(entry.attemptCount, failedNow);
    const message = error instanceof Error ? error.message : String(error);
    await ctx.ports.outbox.markFailed(entry.id, {
      error: message,
      now: failedNow,
      nextAttemptAt
    });
    logger.warn(
      {
        event: nextAttemptAt === null ? "outbox.dead_letter" : "outbox.retry_scheduled",
        outboxId: entry.id,
        sessionId: entry.sessionId,
        dedupeKey: entry.dedupeKey,
        attempt: entry.attemptCount,
        nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
        error: message
      },
      "Outbox worker: send failed."
    );
  }
};

/**
 * Runs one outbox worker tick: claim a batch and deliver each entry.
 *
 * @remarks
 * idempotent: 各 entry は独自 try/catch で隔離され、1 件失敗が次の entry を止めない。
 *   Worker 全体の例外は呼び出し側 (`runTickSafely`) が閉じ込める。
 */
export const runOutboxWorkerTick = async (
  client: Client,
  ctx: AppContext
): Promise<void> => {
  const now = ctx.clock.now();
  const batch = await ctx.ports.outbox.claimNextBatch({
    limit: OUTBOX_WORKER_BATCH_LIMIT,
    now,
    claimDurationMs: OUTBOX_CLAIM_DURATION_MS
  });
  if (batch.length === 0) {return;}
  for (const entry of batch) {
    await deliverOne(client, ctx, entry);
  }
};
