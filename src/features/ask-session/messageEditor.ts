import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import { logger } from "../../logger.js";
import { isUnknownMessageError } from "../../scheduler/reconciler.js";
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
    if (isUnknownMessageError(error)) {
      // state: Discord 側で message が削除 (管理者操作 / アカウント削除) された場合は復旧できないため、
      //   新規投稿し askMessageId を更新する。DB-as-SoT (ADR-0001): 状態は巻き戻さず ID だけ差し替える。
      // @see docs/adr/0033-startup-invariant-reconciler.md invariant D
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
