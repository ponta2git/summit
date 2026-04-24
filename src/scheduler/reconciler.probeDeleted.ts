import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import type { SessionRow } from "../db/rows.js";
import { getTextChannel } from "../discord/shared/channels.js";
import { isUnknownMessageError } from "../discord/shared/discordErrors.js";
import { renderAskBody } from "../features/ask-session/render.js";
import { buildAskMessageViewModel } from "../features/ask-session/viewModel.js";
import { renderPostponeBody } from "../features/postpone-voting/render.js";
import { buildPostponeMessageViewModel } from "../features/postpone-voting/viewModel.js";
import { logger } from "../logger.js";

/**
 * Invariant D (startup active probe): Detect deleted Discord messages at boot.
 *
 * @remarks
 * `updateAskMessage` は opportunistic に 10008 を拾って再投稿するが、停止中は interaction が
 * 無いため ask / postpone メッセージが削除されたまま放置される。startup 時のみ能動的に fetch し、
 * Unknown Message (10008) 検知で新規投稿して ID を差し替える。tick scope では毎分 fetch コストに
 * 見合わないため実施しない。
 * @see ADR-0033
 */
export const probeDeletedMessagesAtStartup = async (
  client: Client,
  ctx: AppContext
): Promise<number> => {
  const nonTerminal = await ctx.ports.sessions.findNonTerminalSessions();
  let recreated = 0;
  for (const session of nonTerminal) {
    try {
      if (await probeAndRecreateAskMessage(client, ctx, session)) {
        recreated += 1;
      }
      if (await probeAndRecreatePostponeMessage(client, ctx, session)) {
        recreated += 1;
      }
    } catch (error: unknown) {
      logger.error(
        {
          error,
          event: "reconciler.message_probe_failed",
          sessionId: session.id,
          weekKey: session.weekKey
        },
        "Reconciler: failed to probe session messages at startup."
      );
    }
  }
  return recreated;
};

const probeAndRecreateAskMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<boolean> => {
  if (!session.askMessageId) {return false;}
  const channel = await getTextChannel(client, session.channelId);
  logger.debug(
    {
      event: "reconciler.message_probed",
      sessionId: session.id,
      weekKey: session.weekKey,
      kind: "ask",
      messageId: session.askMessageId
    },
    "Reconciler: probing ask message."
  );
  try {
    await channel.messages.fetch(session.askMessageId);
    return false;
  } catch (error: unknown) {
    if (!isUnknownMessageError(error)) {
      logger.warn(
        {
          error,
          event: "reconciler.message_probe_error",
          sessionId: session.id,
          weekKey: session.weekKey,
          kind: "ask",
          messageId: session.askMessageId
        },
        "Reconciler: ask message probe failed with non-10008 error."
      );
      return false;
    }
    // state: messageEditor.ts の 10008 フォールバックと同 viewModel で新規投稿し ID を差し替え。
    const memberRows = await ctx.ports.members.listMembers();
    const fresh = await ctx.ports.sessions.findSessionById(session.id);
    if (!fresh) {return false;}
    const responses = await ctx.ports.responses.listResponses(fresh.id);
    const vm = buildAskMessageViewModel(fresh, responses, memberRows);
    const sent = await channel.send(renderAskBody(vm));
    await ctx.ports.sessions.updateAskMessageId(session.id, sent.id);
    logger.warn(
      {
        event: "reconciler.message_recreated_at_startup",
        sessionId: session.id,
        weekKey: session.weekKey,
        kind: "ask",
        previousMessageId: session.askMessageId,
        messageId: sent.id
      },
      "Reconciler: recreated deleted ask message detected at startup."
    );
    return true;
  }
};

const probeAndRecreatePostponeMessage = async (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): Promise<boolean> => {
  if (session.status !== "POSTPONE_VOTING" && session.status !== "POSTPONED") {
    return false;
  }
  if (!session.postponeMessageId) {return false;}
  const channel = await getTextChannel(client, session.channelId);
  logger.debug(
    {
      event: "reconciler.message_probed",
      sessionId: session.id,
      weekKey: session.weekKey,
      kind: "postpone",
      messageId: session.postponeMessageId
    },
    "Reconciler: probing postpone message."
  );
  try {
    await channel.messages.fetch(session.postponeMessageId);
    return false;
  } catch (error: unknown) {
    if (!isUnknownMessageError(error)) {
      logger.warn(
        {
          error,
          event: "reconciler.message_probe_error",
          sessionId: session.id,
          weekKey: session.weekKey,
          kind: "postpone",
          messageId: session.postponeMessageId
        },
        "Reconciler: postpone message probe failed with non-10008 error."
      );
      return false;
    }
    const postponeVm = buildPostponeMessageViewModel(session);
    const sent = await channel.send(renderPostponeBody(postponeVm));
    await ctx.ports.sessions.updatePostponeMessageId(session.id, sent.id);
    logger.warn(
      {
        event: "reconciler.message_recreated_at_startup",
        sessionId: session.id,
        weekKey: session.weekKey,
        kind: "postpone",
        previousMessageId: session.postponeMessageId,
        messageId: sent.id
      },
      "Reconciler: recreated deleted postpone message detected at startup."
    );
    return true;
  }
};
