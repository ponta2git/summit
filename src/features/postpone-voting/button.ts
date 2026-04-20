import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import { ResultAsync, okAsync } from "neverthrow";

import type { AppContext } from "../../composition.js";
import type { SessionRow } from "../../db/types.js";
import {
  type AppError,
  type AppResult,
  okResult,
  toAppError
} from "../../errors/index.js";
import { toResultAsync, fromDatabasePromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import { messages } from "../../messages.js";
import { renderPostponeBody } from "./render.js";
import { buildPostponeMessageViewModel } from "../../discord/shared/viewModels.js";
import {
  getGuardFailureReason,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  guardPostponeCustomId,
  guardRegisteredMemberId,
  guardSessionExists,
  guardSessionPostponeDeadlineOpen,
  guardSessionPostponeVoting,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.js";
import { settlePostponeVotingSession } from "./settle.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";

const POSTPONE_CUSTOM_ID_TO_DB_CHOICE = {
  ok: "POSTPONE_OK",
  ng: "POSTPONE_NG"
} as const;

interface PostponePipelineStart {
  readonly interaction: ButtonInteraction;
  readonly deps: InteractionHandlerDeps;
  readonly context: AppContext;
}

interface PostponePipelineParsed extends PostponePipelineStart {
  readonly sessionId: string;
  readonly choice: "ok" | "ng";
  readonly responseChoice: "POSTPONE_OK" | "POSTPONE_NG";
}

interface PostponePipelineWithSession extends PostponePipelineParsed {
  readonly session: SessionRow;
}

interface PostponePipelineReady extends PostponePipelineWithSession {
  readonly memberId: string;
}

const validatePostponePipeline = (context: PostponePipelineStart): AppResult<PostponePipelineParsed, AppError> =>
  okResult(context)
    // ack: postpone handler 単体で呼ばれても 3 秒制約内のガード順序を守るため、ここで cheap-first を固定する。
    .andThen((current) => guardGuildId(current.interaction.guildId).map(() => current))
    .andThen((current) => guardChannelId(current.interaction.channelId).map(() => current))
    .andThen((current) => guardMemberUserId(current.interaction.user.id).map(() => current))
    .andThen((current) =>
      guardPostponeCustomId(current.interaction.customId).map((parsed) => ({
        ...current,
        sessionId: parsed.sessionId,
        choice: parsed.choice,
        responseChoice: POSTPONE_CUSTOM_ID_TO_DB_CHOICE[parsed.choice]
      }))
    );

const loadSessionStep = (context: PostponePipelineParsed): ResultAsync<PostponePipelineWithSession, AppError> =>
  fromDatabasePromise(
    context.context.ports.sessions.findSessionById(context.sessionId),
    "Failed to load session while handling postpone button."
  )
    .andThen((session) => toResultAsync(guardSessionExists(session)))
    .andThen((session) => toResultAsync(guardSessionPostponeVoting(session)))
    .andThen((session) =>
      toResultAsync(guardSessionPostponeDeadlineOpen(session, context.context.clock.now()))
    )
    .map((session) => ({
      ...context,
      session
    }));

const loadMemberStep = (context: PostponePipelineWithSession): ResultAsync<PostponePipelineReady, AppError> =>
  fromDatabasePromise(
    context.context.ports.members.findMemberIdByUserId(context.interaction.user.id),
    "Failed to resolve member while handling postpone button."
  )
    .andThen((memberId) => toResultAsync(guardRegisteredMemberId(memberId)))
    .map((memberId) => ({
      ...context,
      memberId
    }));

const recordResponseStep = (context: PostponePipelineReady): ResultAsync<PostponePipelineReady, AppError> =>
  fromDatabasePromise(
    context.context.ports.responses.upsertResponse({
      id: randomUUID(),
      sessionId: context.sessionId,
      memberId: context.memberId,
      choice: context.responseChoice,
      answeredAt: context.context.clock.now()
    }),
    "Failed to record postpone response."
  )
    // race: responses.(sessionId, memberId) unique 制約 + upsert で再投票でも最新 1 件に収束する。
    .map(() => context)
    .andTee((current) => {
      logger.info(
        {
          interactionId: current.interaction.id,
          customId: current.interaction.customId,
          sessionId: current.sessionId,
          weekKey: current.session.weekKey,
          userId: current.interaction.user.id,
          memberId: current.memberId,
          choice: current.responseChoice
        },
        "Postpone response recorded."
      );
    });

const refreshPostponeMessageStep = (context: PostponePipelineReady): ResultAsync<void, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.context.ports.responses.listResponses(context.sessionId),
      context.context.ports.members.listMembers()
    ]),
    "Failed to load postpone message snapshot."
  )
    .andThen(([responses, memberRows]) =>
      fromDatabasePromise(
        context.context.ports.sessions.findSessionById(context.sessionId),
        "Failed to reload session after postpone response."
      ).map((freshSession) => ({
        freshSession,
        responses,
        memberRows
      }))
    )
    .andThen(({ freshSession, responses, memberRows }) => {
      if (!freshSession || !freshSession.postponeMessageId) {
        return okAsync(undefined);
      }

      const vm = buildPostponeMessageViewModel(freshSession, responses, memberRows, {
        disabled: false
      });
      const rendered = renderPostponeBody(vm);
      const editPayload = {
        content: rendered.content ?? "",
        ...(rendered.components ? { components: rendered.components } : {})
      };
      // source-of-truth: 再描画は常に DB から再取得した session + responses を正本として構築する。
      return ResultAsync.fromPromise(
        context.interaction.message.edit(editPayload),
        (cause) => toAppError(cause, "Failed to edit postpone message after response.")
      )
        .map(() => undefined)
        .orElse((error) => {
          // race: edit 失敗でも DB を巻き戻さず、次 tick / 次押下の再描画で回復させる。
          logger.warn(
            {
              error,
              interactionId: context.interaction.id,
              customId: context.interaction.customId,
              sessionId: context.sessionId,
              weekKey: freshSession.weekKey,
              userId: context.interaction.user.id,
              messageId: freshSession.postponeMessageId
            },
            "Failed to edit postpone message after response."
          );
          return okAsync(undefined);
        });
    });

const settlePostponeStep = (context: PostponePipelineReady): ResultAsync<void, AppError> =>
  ResultAsync.fromPromise(
    settlePostponeVotingSession(
      context.deps.client,
      context.context,
      context.session,
      context.context.clock.now()
    ),
    (cause) => toAppError(cause, "Failed to settle postpone voting session.")
  );

const handlePostponePipelineError = async (
  interaction: ButtonInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (!reason) {
    throw error;
  }

  logger.info(
    {
      interactionId: interaction.id,
      customId: interaction.customId,
      userId: interaction.user.id,
      reason
    },
    "Rejected postpone button interaction by guard."
  );

  await interaction.followUp({
    content: GUARD_REASON_TO_MESSAGE[reason],
    flags: MessageFlags.Ephemeral
  });
};

/**
 * Handle postpone button interactions via cheap-first validation and DB-backed pipeline composition.
 */
export const handlePostponeButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  // ack: component interaction は 3 秒制約があるため handler 入口で deferUpdate() する。
  await interaction.deferUpdate();

  const pipelineStart: PostponePipelineStart = {
    interaction,
    deps,
    context: deps.context
  };

  const result = await toResultAsync(validatePostponePipeline(pipelineStart))
    .andThen(loadSessionStep)
    .andThen(loadMemberStep)
    .andThen(recordResponseStep)
    .andThen((context) => refreshPostponeMessageStep(context).map(() => context))
    .andThen((context) => settlePostponeStep(context).map(() => context));

  await result.match(
    async (context) => {
      try {
        await interaction.followUp({
          content: messages.interaction.voteConfirmed.postpone(context.choice),
          flags: MessageFlags.Ephemeral
        });
        logger.info(
          {
            interactionId: interaction.id,
            customId: interaction.customId,
            sessionId: context.sessionId,
            weekKey: context.session.weekKey,
            userId: interaction.user.id,
            choice: context.choice
          },
          "postponeVoteConfirmSent"
        );
      } catch (err: unknown) {
        logger.warn(
          {
            err,
            interactionId: interaction.id,
            customId: interaction.customId,
            sessionId: context.sessionId,
            weekKey: context.session.weekKey,
            userId: interaction.user.id
          },
          "Failed to send postpone vote confirmation followUp."
        );
      }
    },
    async (error) => handlePostponePipelineError(interaction, error)
  );
};
