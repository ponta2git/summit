import type { Client, MessageCreateOptions } from "discord.js";

import type { AppContext } from "../appContext.js";
import {
  OUTBOX_BACKOFF_MS_SEQUENCE,
  OUTBOX_CLAIM_DURATION_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_WORKER_BATCH_LIMIT
} from "../config.js";
import type { OutboxEntry } from "../db/ports.js";
import { logger } from "../logger.js";
import { getTextChannel } from "../discord/shared/channels.js";
import { cancelWeekMessages } from "../features/cancel-week/messages.js";
import {
  buildDecidedAnnouncementViewModel
} from "../features/decided-announcement/viewModel.js";
import { renderDecidedAnnouncement } from "../features/decided-announcement/send.js";

/**
 * Compute next_attempt_at from the current attempt count via exponential backoff.
 *
 * @remarks
 * state: `attemptCount >= OUTBOX_MAX_ATTEMPTS` で `null` を返し dead letter (FAILED)。
 * `attemptCount` は claim で +1 された後の値。
 * @see ADR-0035
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
  return new Date(now.getTime() + delayMs);
};

type RendererFn = (input: {
  readonly ctx: AppContext;
  readonly entry: OutboxEntry;
}) => Promise<MessageCreateOptions | undefined>;

const extractString = (extra: Record<string, unknown> | undefined, key: string): string | undefined => {
  const v = extra?.[key];
  return typeof v === "string" ? v : undefined;
};

const extractBoolean = (extra: Record<string, unknown> | undefined, key: string): boolean => {
  return extra?.[key] === true;
};

// why: renderer 名を型で固定し ADR-0035 のカバレッジを grep 可能にする。未登録 renderer は dead letter。
const renderers: Readonly<Record<string, RendererFn>> = {
  raw_text: async ({ entry }) => {
    if (entry.payload.kind !== "send_message") {return undefined;}
    const content = extractString(entry.payload.extra, "content");
    return content === undefined ? undefined : { content };
  },
  // source-of-truth: DECIDED Session を DB から再取得し VM から構築する (state mismatch は dead letter)。
  decided_announcement: async ({ ctx, entry }) => {
    const session = await ctx.ports.sessions.findSessionById(entry.sessionId);
    if (!session || session.status !== "DECIDED" || !session.decidedStartAt) {
      return undefined;
    }
    const [responses, members] = await Promise.all([
      ctx.ports.responses.listResponses(session.id),
      ctx.ports.members.listMembers()
    ]);
    const vm = buildDecidedAnnouncementViewModel(session, responses, members);
    if (!vm) {return undefined;}
    return renderDecidedAnnouncement(vm);
  },

  cancel_week_notice: async ({ entry }) => {
    if (entry.payload.kind !== "send_message") {return undefined;}
    const invokerUserId = extractString(entry.payload.extra, "invokerUserId");
    if (invokerUserId === undefined) {return undefined;}
    const suppressMentions = extractBoolean(entry.payload.extra, "suppressMentions");
    const content = suppressMentions
      ? cancelWeekMessages.cancelWeek.suppressedChannelNotice({ invokerUserId })
      : cancelWeekMessages.cancelWeek.channelNotice({ invokerUserId });
    return { content };
  }
};

const renderPayload = async (
  ctx: AppContext,
  entry: OutboxEntry
): Promise<MessageCreateOptions | undefined> => {
  const payload = entry.payload;
  if (payload.kind !== "send_message") {return undefined;}
  const rendererName = payload.renderer;
  const fn = renderers[rendererName];
  if (fn) {
    return fn({ ctx, entry });
  }
  // why: 未登録 renderer は extra.content を fallback で拾う (text-only 後方互換)。
  const content = extractString(payload.extra, "content");
  return content === undefined ? undefined : { content };
};

const deliverOne = async (
  client: Client,
  ctx: AppContext,
  entry: OutboxEntry
): Promise<void> => {
  const now = ctx.clock.now();
  const payload = entry.payload;

  const body = await renderPayload(ctx, entry);
  if (body === undefined) {
    // state: 未対応 renderer / state mismatch は dead letter (握り潰し禁止)。
    await ctx.ports.outbox.markFailed(entry.id, {
      error: `Unsupported outbox payload: kind=${payload.kind}, renderer=${payload.kind === "send_message" ? payload.renderer : "n/a"}`,
      now,
      nextAttemptAt: null
    });
    logger.error(
      {
        event: "outbox.unsupported_payload",
        outboxId: entry.id,
        sessionId: entry.sessionId,
        kind: payload.kind,
        renderer: payload.kind === "send_message" ? payload.renderer : undefined,
        dedupeKey: entry.dedupeKey
      },
      "Outbox worker: unsupported payload; moved to FAILED."
    );
    return;
  }

  try {
    // invariant: body !== undefined を通過した時点で payload.kind === "send_message" が確定する (renderPayload 契約)。
    if (payload.kind === "send_message") {
      const channel = await getTextChannel(client, payload.channelId);
      const sent = await channel.send(body);
      await ctx.ports.outbox.markDelivered(entry.id, {
        deliveredMessageId: sent.id,
        now: ctx.clock.now()
      });
      // race: reconciler 再投稿と重なっても CAS-on-NULL により先勝ちが保証される (ADR-0035 FR-M2)。
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
 * Claim a batch of PENDING outbox entries and deliver each.
 *
 * @remarks
 * idempotent: 各 entry は独立の try/catch で隔離。全体例外は呼び出し側 (`runTickSafely`) が閉じ込める。
 * @see ADR-0035
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
