// why: Discord send outbox worker (ADR-0035)。状態遷移と送信を非同期に分離し、
//   PENDING 行を claim → Discord に配送 → DELIVERED / FAILED に遷移させる。
//   tickRunner の最初の consumer として `runTickSafely` で例外を閉じ込める (ADR-0033 期の基盤)。

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
 * Render the Discord message body for an outbox entry.
 *
 * @remarks
 * Dispatches on `payload.renderer`. Stateless renderers use `payload.extra` only.
 * State-aware renderers (e.g. `decided_announcement`) fetch the latest state from DB at
 * dispatch time so the message reflects the SoT at delivery rather than at enqueue.
 *
 * 未対応 renderer は `undefined` を返す → 呼び出し側が dead letter (FAILED) に落とす。
 * 握り潰しは禁止 (AGENTS.md rule)。
 * @see docs/adr/0035-discord-send-outbox.md
 */
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

// why: renderer 名を型で固定し ADR-0035 のカバレッジを grep 可能にする。
//   新規 renderer 追加時はこの map に 1 行追加する。worker ruleset 外の kind/renderer は dead letter。
const renderers: Readonly<Record<string, RendererFn>> = {
  // raw_text: 既存の text-only 経路 (初期 outbox 利用, 後方互換)。
  raw_text: async ({ entry }) => {
    if (entry.payload.kind !== "send_message") {return undefined;}
    const content = extractString(entry.payload.extra, "content");
    return content === undefined ? undefined : { content };
  },
  // decided_announcement: §5.1 開催決定通知。
  //   state-aware: DECIDED Session を DB から再取得し VM から構築する。
  //   state が DECIDED 以外 (例: レース後に COMPLETED へ遷移) の場合は `undefined` を返して dead letter。
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
  // cancel_week_notice: /cancel_week 通知 (チャンネル 1 回ポスト)。stateless。
  //   invokerUserId / suppressMentions を extra に積んでおき worker tick で render する。
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
  // why: 既存テスト / 初期実装は `renderer` 未設定 (`"ask_body"` など) + `extra.content` の text を想定。
  //   未登録 renderer の場合は raw_text と同じく extra.content を fallback で拾う (後方互換)。
  //   これは明示的な text-only 送信 (settle 初期実装などの過渡期経路) を壊さないための措置。
  const fn = renderers[rendererName];
  if (fn) {
    return fn({ ctx, entry });
  }
  const content = extractString(payload.extra, "content");
  return content === undefined ? undefined : { content };
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

  const body = await renderPayload(ctx, entry);
  if (body === undefined) {
    // state: 未対応 renderer / state mismatch は dead letter。握り潰しは禁止 (AGENTS.md rule)。
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
    // invariant: body !== undefined を通過した時点で renderPayload の契約上 payload.kind === "send_message" が確定する (L108-124)。
    //   edit_message は body === undefined になり L145-163 の dead-letter 経路で既に処理済み (ADR-0035 Consequences)。
    if (payload.kind === "send_message") {
      const channel = await getTextChannel(client, payload.channelId);
      const sent = await channel.send(body);
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
