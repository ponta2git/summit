import type { Client } from "discord.js";
import { errAsync, okAsync, safeTry } from "neverthrow";

import type { AppContext } from "../appContext.ts";
import type { SessionRow } from "../db/rows.ts";
import { fromDatabaseCall, fromDiscordCall } from "../errors/result.ts";
import { getTextChannel } from "../discord/shared/channels.ts";
import { isUnknownMessageError } from "../discord/shared/discordErrors.ts";
import { renderAskBody } from "../features/ask-session/render.ts";
import { buildAskMessageViewModel } from "../features/ask-session/viewModel.ts";
import { renderPostponeBody } from "../features/postpone-voting/render.ts";
import { buildPostponeMessageViewModel } from "../features/postpone-voting/viewModel.ts";
import { logger } from "../logger.ts";
import {
  runSchedulerBatchResult,
  type SchedulerBatchReport,
  type SchedulerResult
} from "./scheduler.types.ts";

/**
 * Invariant D (startup active probe): Detect deleted Discord messages at boot.
 *
 * @remarks
 * `updateAskMessage` は opportunistic に 10008 を拾って再投稿するが、停止中は interaction が
 * 無いため ask / postpone メッセージが削除されたまま放置される。startup 時のみ能動的に fetch し、
 * Unknown Message (10008) 検知で新規投稿して ID を差し替える。tick scope では毎分 fetch コストに
 * 見合わないため実施しない。
 * @see ADR-0051
 */
export const probeDeletedMessagesAtStartup = (
  client: Client,
  ctx: AppContext
): SchedulerResult<SchedulerBatchReport> =>
  fromDatabaseCall(
    () => ctx.ports.sessions.findNonTerminalSessions(),
    "Failed to find non-terminal sessions for message probing."
  ).andThen((nonTerminal) =>
    runSchedulerBatchResult(
      "message_probe",
      nonTerminal,
      (session) => safeTry(async function* () {
        const ask = yield* probeAndRecreateAskMessage(client, ctx, session);
        const postpone = yield* probeAndRecreatePostponeMessage(client, ctx, session);
        return okAsync((ask ? 1 : 0) + (postpone ? 1 : 0));
      }),
      (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
      (failure) => {
        logger.error(
          {
            error: failure.error,
            errorCode: failure.error.code,
            event: "reconciler.message_probe_failed",
            sessionId: failure.sessionId,
            weekKey: failure.weekKey
          },
          "Reconciler: failed to probe session messages at startup."
        );
      },
      (recreated) => recreated
    )
  );

type ProbeChannel = Awaited<ReturnType<typeof getTextChannel>>;
type ProbeKind = "ask" | "postpone";

const probeMessage = (
  client: Client,
  session: SessionRow,
  kind: ProbeKind,
  messageId: string,
  recreate: (channel: ProbeChannel) => SchedulerResult<boolean>
): SchedulerResult<boolean> =>
  fromDiscordCall(
    () => getTextChannel(client, session.channelId),
    `Failed to load channel for ${kind} message probe.`
  ).andThen((channel) => {
    logger.debug(
      {
        event: "reconciler.message_probed",
        sessionId: session.id,
        weekKey: session.weekKey,
        kind,
        messageId
      },
      `Reconciler: probing ${kind} message.`
    );
    return fromDiscordCall(
      () => channel.messages.fetch(messageId),
      `Failed to fetch ${kind} message during startup probe.`
    ).map(() => false).orElse((error) =>
      isUnknownMessageError(error.cause) ? recreate(channel) : errAsync(error)
    );
  });

const recreateAskMessage = (
  channel: ProbeChannel,
  ctx: AppContext,
  session: SessionRow
): SchedulerResult<boolean> =>
  safeTry(async function* () {
    const memberRows = yield* fromDatabaseCall(
      () => ctx.ports.members.listMembers(),
      "Failed to load members for ask message recreation."
    );
    const fresh = yield* fromDatabaseCall(
      () => ctx.ports.sessions.findSessionById(session.id),
      "Failed to reload session for ask message recreation."
    );
    if (!fresh) {return okAsync(false);}
    const responses = yield* fromDatabaseCall(
      () => ctx.ports.responses.listResponses(fresh.id),
      "Failed to load responses for ask message recreation."
    );
    const sent = yield* fromDiscordCall(
      () => channel.send(renderAskBody(buildAskMessageViewModel(fresh, responses, memberRows))),
      "Failed to recreate deleted ask message."
    );
    yield* fromDatabaseCall(
      () => ctx.ports.sessions.updateAskMessageId(session.id, sent.id),
      "Failed to persist recreated ask message id."
    );
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
    return okAsync(true);
  });

const probeAndRecreateAskMessage = (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): SchedulerResult<boolean> => {
  if (!session.askMessageId) {return okAsync(false);}
  return probeMessage(client, session, "ask", session.askMessageId, (channel) =>
    recreateAskMessage(channel, ctx, session)
  );
};

const recreatePostponeMessage = (
  channel: ProbeChannel,
  ctx: AppContext,
  session: SessionRow
): SchedulerResult<boolean> =>
  safeTry(async function* () {
    const sent = yield* fromDiscordCall(
      () => channel.send(renderPostponeBody(buildPostponeMessageViewModel(session))),
      "Failed to recreate deleted postpone message."
    );
    yield* fromDatabaseCall(
      () => ctx.ports.sessions.updatePostponeMessageId(session.id, sent.id),
      "Failed to persist recreated postpone message id."
    );
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
    return okAsync(true);
  });

const probeAndRecreatePostponeMessage = (
  client: Client,
  ctx: AppContext,
  session: SessionRow
): SchedulerResult<boolean> => {
  if (session.status !== "POSTPONE_VOTING" && session.status !== "POSTPONED") {
    return okAsync(false);
  }
  if (!session.postponeMessageId) {return okAsync(false);}
  return probeMessage(client, session, "postpone", session.postponeMessageId, (channel) =>
    recreatePostponeMessage(channel, ctx, session)
  );
};
