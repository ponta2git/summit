import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import { logger } from "../../logger.js";
import { isUnknownMessageError } from "../../discord/shared/discordErrors.js";
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
  const responses = await ctx.ports.responses.listResponses(fresh.id);
  const vm = buildAskMessageViewModel(fresh, responses, memberRows);
  const rendered = renderAskBody(vm);
  try {
    const msg = await channel.messages.fetch(session.askMessageId);
    await msg.edit(rendered);
  } catch (error: unknown) {
    if (isUnknownMessageError(error)) {
      // state: Discord 側で message が消されたら復旧不可のため新規投稿して askMessageId を差し替える。
      //   source-of-truth: DB-as-SoT。状態は巻き戻さず ID だけ更新する。
      // @see ADR-0001
      // @see ADR-0033
      try {
        const sent = await channel.send(rendered);
        await ctx.ports.sessions.updateAskMessageId(session.id, sent.id);
        logger.warn(
          {
            event: "reconciler.message_recreated",
            sessionId: session.id,
            weekKey: session.weekKey,
            previousMessageId: session.askMessageId,
            messageId: sent.id
          },
          "Reconciler: recreated ask message after Unknown Message (10008)."
        );
      } catch (recreateError: unknown) {
        logger.error(
          {
            error: recreateError,
            event: "reconciler.message_recreated_failed",
            sessionId: session.id,
            weekKey: session.weekKey,
            previousMessageId: session.askMessageId
          },
          "Reconciler: failed to recreate ask message after Unknown Message."
        );
      }
      return;
    }
    logger.warn(
      { error, sessionId: session.id, messageId: session.askMessageId },
      "Failed to update ask message."
    );
  }
};
