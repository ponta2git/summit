import { ChannelType, type Client } from "discord.js";

import {
  findSessionById,
  listMembers,
  setPostponeMessageId,
  transitionStatus,
  type DbLike,
  type SessionRow
} from "../db/repositories/sessions.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { buildAskRenderFromDb } from "./ask/render.js";
import { renderPostponeBody } from "./postponeMessage.js";

export type CancelReason = "absent" | "deadline_unanswered";

const getTextChannel = async (client: Client, channelId: string) => {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.isSendable()) {
    throw new Error("Configured channel is not sendable.");
  }
  return channel;
};

export const refreshAskMessage = async (
  client: Client,
  db: DbLike,
  session: SessionRow
): Promise<void> => {
  if (!session.askMessageId) {return;}
  const channel = await getTextChannel(client, session.channelId);
  const memberRows = await listMembers(db);
  const memberLookup = new Map(memberRows.map((m) => [m.id, m.userId]));
  const fresh = await findSessionById(db, session.id);
  if (!fresh) {return;}
  const rendered = await buildAskRenderFromDb(db, fresh, memberLookup);
  try {
    const msg = await channel.messages.fetch(session.askMessageId);
    await msg.edit(rendered);
  } catch (error: unknown) {
    logger.warn(
      { error, sessionId: session.id, messageId: session.askMessageId },
      "Failed to refresh ask message."
    );
  }
};

/**
 * Transition an ASKING session to CANCELLED, refresh ask message,
 * post the cancel message, post the postpone confirmation message,
 * and transition CANCELLED → POSTPONE_VOTING. Fully idempotent.
 */
export const settleAskingSession = async (
  client: Client,
  db: DbLike,
  sessionId: string,
  reason: CancelReason
): Promise<void> => {
  const current = await findSessionById(db, sessionId);
  if (!current) {return;}
  if (current.status !== "ASKING") {
    logger.info(
      { sessionId, status: current.status, reason },
      "settleAskingSession called on non-ASKING session; skipping."
    );
    return;
  }

  const cancelled = await transitionStatus(db, {
    id: sessionId,
    from: "ASKING",
    to: "CANCELLED",
    cancelReason: reason
  });
  if (!cancelled) {
    logger.info({ sessionId, reason }, "ASKING→CANCELLED race; another path settled first.");
    return;
  }

  logger.info(
    { sessionId, weekKey: cancelled.weekKey, from: "ASKING", to: "CANCELLED", reason },
    "Session cancelled."
  );

  await refreshAskMessage(client, db, cancelled);

  const channel = await getTextChannel(client, cancelled.channelId);

  const cancelContent =
    reason === "absent"
      ? "🛑 欠席が出たため、今週の開催は中止です。"
      : "🛑 21:30 までに未回答者がいたため、今週の開催は中止です。";

  const mentions = env.MEMBER_USER_IDS.map((id) => `<@${id}>`).join(" ");
  await channel.send({ content: `${mentions}\n${cancelContent}` });

  const postponeSent = await channel.send(renderPostponeBody(cancelled));
  await setPostponeMessageId(db, cancelled.id, postponeSent.id);

  const transitioned = await transitionStatus(db, {
    id: sessionId,
    from: "CANCELLED",
    to: "POSTPONE_VOTING"
  });
  if (transitioned) {
    logger.info(
      {
        sessionId,
        weekKey: cancelled.weekKey,
        from: "CANCELLED",
        to: "POSTPONE_VOTING",
        postponeMessageId: postponeSent.id
      },
      "Postpone voting started."
    );
  }
};

/**
 * If all 4 members have responded with time choices (no ABSENT),
 * transition ASKING → DECIDED and record decided_start_at.
 * Returns true when the transition was performed.
 */
export const tryDecideIfAllTimeSlots = async (
  db: DbLike,
  session: SessionRow,
  decidedStart: Date
): Promise<boolean> => {
  const result = await transitionStatus(db, {
    id: session.id,
    from: "ASKING",
    to: "DECIDED",
    decidedStartAt: decidedStart
  });
  if (result) {
    logger.info(
      {
        sessionId: session.id,
        weekKey: session.weekKey,
        from: "ASKING",
        to: "DECIDED",
        decidedStartAt: decidedStart.toISOString()
      },
      "Session decided."
    );
    return true;
  }
  return false;
};
