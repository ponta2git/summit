import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import type { SessionRow } from "../db/rows.js";
import { getTextChannel } from "../discord/shared/channels.js";
import { renderAskBody } from "../features/ask-session/render.js";
import { sendPostponedAskMessage } from "../features/ask-session/send.js";
import { buildAskMessageViewModel } from "../features/ask-session/viewModel.js";
import { logger } from "../logger.js";

/**
 * Invariant C: Recover non-terminal sessions whose `askMessageId` is NULL.
 *
 * @remarks
 * `createAskSession` 成功後 `channel.send` 失敗で askMessageId=NULL のまま放置されると
 * (weekKey, postponeCount) unique で再作成不能になる。ASKING/POSTPONE_VOTING/POSTPONED を
 * 対象に再投稿して ID を埋める。
 * @see ADR-0033
 */
export const reconcileMissingAskMessage = async (
  client: Client,
  ctx: AppContext
): Promise<number> => {
  const nonTerminal = await ctx.ports.sessions.findNonTerminalSessions();
  let resent = 0;
  for (const session of nonTerminal) {
    if (session.askMessageId) {continue;}
    if (
      session.status !== "ASKING" &&
      session.status !== "POSTPONE_VOTING" &&
      session.status !== "POSTPONED"
    ) {
      continue;
    }
    try {
      await resendAskMessage(client, ctx, session);
      resent += 1;
    } catch (error: unknown) {
      logger.error(
        {
          error,
          event: "reconciler.message_resent_failed",
          sessionId: session.id,
          weekKey: session.weekKey
        },
        "Reconciler: failed to resend ask message."
      );
    }
  }
  return resent;
};

const resendAskMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<void> => {
  // source-of-truth: postponeCount=1 の ASKING は専用経路で送信し in-flight ロックを共有する。
  if (session.postponeCount === 1 && session.status === "ASKING") {
    await sendPostponedAskMessage(client, ctx, session);
    logger.info(
      {
        event: "reconciler.message_resent",
        sessionId: session.id,
        weekKey: session.weekKey,
        status: session.status
      },
      "Reconciler: resent postponed Saturday ask message."
    );
    return;
  }

  const [channel, memberRows, responses] = await Promise.all([
    getTextChannel(client, session.channelId),
    ctx.ports.members.listMembers(),
    ctx.ports.responses.listResponses(session.id)
  ]);
  const vm = buildAskMessageViewModel(session, responses, memberRows);
  const sent = await channel.send(renderAskBody(vm));
  await ctx.ports.sessions.updateAskMessageId(session.id, sent.id);
  logger.info(
    {
      event: "reconciler.message_resent",
      sessionId: session.id,
      weekKey: session.weekKey,
      messageId: sent.id,
      status: session.status
    },
    "Reconciler: resent ask message."
  );
};
