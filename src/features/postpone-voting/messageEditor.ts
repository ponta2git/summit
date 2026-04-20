import type { Client } from "discord.js";

import type { AppContext } from "../../composition.js";
import type { ResponseRow, SessionRow } from "../../db/types.js";
import { logger } from "../../logger.js";
import { renderPostponeBody } from "./render.js";
import { buildPostponeMessageViewModel } from "./viewModel.js";
import { getTextChannel } from "../../discord/shared/channels.js";

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
