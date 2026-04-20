import { ChannelType, type Client } from "discord.js";

import type { AppContext } from "../../composition.js";
import type {
  ResponseRow,
  SessionRow
} from "../../db/types.js";
import { logger } from "../../logger.js";
import { renderAskBody } from "../ask/render.js";
import { renderPostponeBody } from "../postpone/render.js";
import {
  buildAskMessageViewModel,
  buildPostponeMessageViewModel,
  type SettleNoticeViewModel
} from "../viewModels.js";

export type CancelReason =
  | "absent"
  | "deadline_unanswered"
  | "postpone_ng"
  | "postpone_unanswered"
  | "saturday_cancelled";

export const getTextChannel = async (client: Client, channelId: string) => {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }
  return channel;
};

// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
export const renderSettleNotice = (vm: SettleNoticeViewModel): { content: string } => {
  // why: DEV_SUPPRESS_MENTIONS=true なら mention 行を省く。単純な `${mentions}\n${cancel}` 連結だと
  //   mentions="" のとき先頭改行が残るため、filter で空文字を除外してから join する。
  // @see docs/adr/0011-dev-mention-suppression.md
  const lines = [
    vm.suppressMentions ? "" : vm.memberUserIds.map((id) => `<@${id}>`).join(" "),
    vm.cancelText
  ].filter((line) => line.length > 0);
  return { content: lines.join("\n") };
};

export const updateAskMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  if (!session.askMessageId) {return;}
  const channel = await getTextChannel(client, session.channelId);
  const memberRows = await ctx.ports.members.listMembers();
  const fresh = await ctx.ports.sessions.findSessionById(session.id);
  if (!fresh) {return;}
  // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
  const responses = await ctx.ports.responses.listResponses(fresh.id);
  const vm = buildAskMessageViewModel(fresh, responses, memberRows);
  const rendered = renderAskBody(vm);
  try {
    const msg = await channel.messages.fetch(session.askMessageId);
    await msg.edit(rendered);
  } catch (error: unknown) {
    logger.warn(
      { error, sessionId: session.id, messageId: session.askMessageId },
      "Failed to update ask message."
    );
  }
};

export const updatePostponeMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow,
  responses: readonly ResponseRow[],
  footerText: string
): Promise<void> => {
  if (!session.postponeMessageId) {return;}
  const channel = await getTextChannel(client, session.channelId);
  const memberRows = await ctx.ports.members.listMembers();
  const vm = buildPostponeMessageViewModel(session, responses, memberRows, {
    disabled: true,
    footerText
  });
  const rendered = renderPostponeBody(vm);
  const editPayload = {
    content: rendered.content ?? "",
    ...(rendered.components ? { components: rendered.components } : {})
  };
  try {
    const msg = await channel.messages.fetch(session.postponeMessageId);
    await msg.edit(editPayload);
  } catch (error: unknown) {
    logger.warn(
      { error, sessionId: session.id, messageId: session.postponeMessageId },
      "Failed to update postpone message."
    );
  }
};
