import type { Client } from "discord.js";

import type { AppContext } from "../../composition.js";
import type { SessionRow } from "../../db/types.js";
import { logger } from "../../logger.js";
import { renderAskBody } from "./render.js";
import { buildAskMessageViewModel } from "./viewModel.js";
import { getTextChannel } from "../../discord/shared/channels.js";

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
