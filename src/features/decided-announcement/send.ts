import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import { logger } from "../../logger.js";
import { decidedMessages } from "./messages.js";
import {
  buildDecidedAnnouncementViewModel,
  type DecidedAnnouncementViewModel
} from "./viewModel.js";

import { getTextChannel } from "../../discord/shared/channels.js";

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
 * Send the decided announcement for a DECIDED session.
 *
 * @remarks
 * idempotent: ASKING→DECIDED の CAS が成功した直後にのみ呼ばれ、かつ send 失敗は warn log で許容する
 *   (DB は既に DECIDED、次 tick で retry しない — §5.1 は 1 回限りの announce 想定)。
 *   スキーマに送信追跡列は持たない (Bot 規模に対し過剰、送信失敗は非常に稀)。
 * source-of-truth: session と responses は呼び出し側が DB から取り直したもの。本関数は DB を触らない。
 * @see requirements/base.md §5.1
 */
export const sendDecidedAnnouncement = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  if (session.status !== "DECIDED" || !session.decidedStartAt) {
    return;
  }

  const [responses, members] = await Promise.all([
    ctx.ports.responses.listResponses(session.id),
    ctx.ports.members.listMembers()
  ]);

  const vm = buildDecidedAnnouncementViewModel(session, responses, members);
  if (!vm) {return;}

  try {
    const channel = await getTextChannel(client, session.channelId);
    await channel.send(renderDecidedAnnouncement(vm));
    logger.info(
      {
        sessionId: session.id,
        weekKey: session.weekKey,
        startTimeLabel: vm.startTimeLabel
      },
      "Decided announcement sent."
    );
  } catch (error: unknown) {
    // race: send 失敗は本処理に影響させない。DB は既に DECIDED のまま維持。
    //   リマインド (§5.2) は別系統 (reminder tick) で送るため、ここでの失敗は UX 劣化のみ。
    logger.warn(
      {
        error,
        sessionId: session.id,
        weekKey: session.weekKey
      },
      "Failed to send decided announcement."
    );
  }
};
