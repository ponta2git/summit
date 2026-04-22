import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import { logger } from "../../logger.js";
import { decidedMessages } from "./messages.js";
import { type DecidedAnnouncementViewModel } from "./viewModel.js";

/**
 * Render the decided announcement content (mentions line + body).
 *
 * @remarks
 * Pure. `DEV_SUPPRESS_MENTIONS=true` 時は mention 行を省く (ADR-0011)。
 * ask footer (footerDecided) とは別の独立投稿なので `<@id>` 形式のメンションを含める。
 * @see requirements/base.md §5.1
 */
export const renderDecidedAnnouncement = (
  vm: DecidedAnnouncementViewModel
): { content: string } => {
  const body = decidedMessages.decided.body({
    startTimeLabel: vm.startTimeLabel,
    memberLines: vm.memberLines
  });
  // why: DEV_SUPPRESS_MENTIONS 時は mention 行を省く (settle / reminder と同じ方針)。
  if (vm.suppressMentions) {
    return { content: body };
  }
  const mentions = vm.memberUserIds.map((id) => `<@${id}>`).join(" ");
  return { content: `${mentions}\n${body}` };
};

/**
 * Enqueue the decided announcement for a DECIDED session into the outbox.
 *
 * @remarks
 * idempotent: ASKING→DECIDED の CAS が成功した直後に呼ばれる。`dedupeKey=decided-announcement-{sessionId}`
 *   で at-most-once を保証する (再 enqueue は `skipped=true` で no-op)。
 * state: Session が DECIDED でなければ no-op。reconnect-replay で再呼び出しされても dedupe で守る。
 * source-of-truth: 実 render は outbox worker tick で DB から最新 session/responses/members を取り直して構築する
 *   (@see scheduler/outboxWorker.ts の `decided_announcement` renderer)。
 * @see requirements/base.md §5.1
 * @see docs/adr/0035-discord-send-outbox.md
 */
export const sendDecidedAnnouncement = async (
  _client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  if (session.status !== "DECIDED" || !session.decidedStartAt) {
    return;
  }

  const enqueued = await ctx.ports.outbox.enqueue({
    kind: "send_message",
    sessionId: session.id,
    dedupeKey: `decided-announcement-${session.id}`,
    payload: {
      kind: "send_message",
      channelId: session.channelId,
      renderer: "decided_announcement",
      extra: {}
    }
  });
  logger.info(
    {
      event: enqueued.skipped ? "decided_announcement.enqueue_skipped" : "decided_announcement.enqueued",
      sessionId: session.id,
      weekKey: session.weekKey,
      outboxId: enqueued.id,
      skipped: enqueued.skipped
    },
    enqueued.skipped
      ? "Decided announcement enqueue skipped (duplicate)."
      : "Decided announcement enqueued to outbox."
  );
};
