import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import { type ResultAsync, okAsync } from "neverthrow";

import type { AppContext } from "../../appContext.js";
import type { ResponseChoice, SessionRow } from "../../db/rows.js";
import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.js";
import { toResultAsync, fromDatabasePromise, fromDiscordPromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import { postponeMessages } from "./messages.js";
import { renderPostponeBody } from "./render.js";
import { buildPostponeMessageViewModel } from "./viewModel.js";
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
import { settlePostponeVotingSession } from "../../orchestration/index.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";
import type { PostponeCustomIdChoice } from "../../discord/shared/customId.js";
import { sendEphemeralConfirmFollowUp } from "../../discord/shared/followUp.js";
import { buildPostponeNgConfirmRow } from "./ngConfirm.js";

const POSTPONE_CUSTOM_ID_TO_DB_CHOICE = {
  ok: "POSTPONE_OK",
  ng: "POSTPONE_NG"
} as const satisfies Record<PostponeCustomIdChoice, ResponseChoice>;

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

interface PostponePipelineReady extends PostponePipelineParsed {
  readonly session: SessionRow;
  readonly memberId: string;
}

const validatePostponePipeline = (context: PostponePipelineStart): AppResult<PostponePipelineParsed, AppError> =>
  okResult(context)
    // ack: handler 単体呼び出しでも 3 秒制約を満たすため cheap-first を固定。
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

const loadSessionAndMemberStep = (context: PostponePipelineParsed): ResultAsync<PostponePipelineReady, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.context.ports.sessions.findSessionById(context.sessionId),
      context.context.ports.members.findMemberIdByUserId(context.interaction.user.id)
    ]),
    "Failed to load DB state while handling postpone button."
  )
    .andThen(([session, memberId]) =>
      toResultAsync(guardSessionExists(session)).map((existingSession) => ({
        session: existingSession,
        memberId
      }))
    )
    // invariant: DB reads are parallel, but guard result precedence remains session → member.
    .andThen(({ session, memberId }) =>
      toResultAsync(guardSessionPostponeVoting(session))
        .andThen((postponeSession) =>
          toResultAsync(guardSessionPostponeDeadlineOpen(postponeSession, context.context.clock.now()))
        )
        .map((postponeSession) => ({ session: postponeSession, memberId }))
    )
    .andThen(({ session, memberId }) =>
      toResultAsync(guardRegisteredMemberId(memberId)).map((registeredMemberId) => ({
        ...context,
        session,
        memberId: registeredMemberId
      }))
    );

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
      return fromDiscordPromise(
        context.interaction.message.edit(editPayload),
        "Failed to edit postpone message after response."
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
  settlePostponeVotingSession(
    context.deps.client,
    context.context,
    context.session,
    context.context.clock.now()
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
 * Handle postpone button interactions.
 *
 * @remarks
 * cheap-first validation → DB-backed pipeline。再描画は常に DB から再構築。
 * NG は不可逆なため確認 dialog を ephemeral で提示し、confirm ボタンで記録する。
 * @see ADR-0001
 */
export const handlePostponeButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  options: {
    readonly acknowledged?: boolean;
  } = {}
): Promise<void> => {
  if (!options.acknowledged) {
    // ack: component interaction の 3 秒制約を満たすため入口で deferUpdate する。
    await interaction.deferUpdate();
  }

  const pipelineStart: PostponePipelineStart = {
    interaction,
    deps,
    context: deps.context
  };

  const validation = validatePostponePipeline(pipelineStart);
  if (validation.isErr()) {
    await handlePostponePipelineError(interaction, validation.error);
    return;
  }

  const parsed = validation.value;

  if (parsed.choice === "ng") {
    const result = await loadSessionAndMemberStep(parsed);
    await result.match(
      async (ctx) => {
        await interaction.followUp({
          content: postponeMessages.ngConfirm.prompt,
          components: [buildPostponeNgConfirmRow(ctx.sessionId)],
          flags: MessageFlags.Ephemeral
        });
        logger.info(
          {
            interactionId: interaction.id,
            customId: interaction.customId,
            sessionId: ctx.sessionId,
            weekKey: ctx.session.weekKey,
            userId: interaction.user.id
          },
          "Postpone NG confirmation dialog shown."
        );
      },
      async (error) => handlePostponePipelineError(interaction, error)
    );
    return;
  }

  const result = await loadSessionAndMemberStep(parsed)
    .andThen(recordResponseStep)
    .andThen((context) => refreshPostponeMessageStep(context).map(() => context))
    .andThen((context) => settlePostponeStep(context).map(() => context));

  await result.match(
    async (context) =>
      sendEphemeralConfirmFollowUp(
        interaction,
        postponeMessages.interaction.voteConfirmed.postpone(context.choice),
        {
          interactionId: interaction.id,
          customId: interaction.customId,
          sessionId: context.sessionId,
          weekKey: context.session.weekKey,
          userId: interaction.user.id,
          choice: context.choice
        },
        "postponeVoteConfirmSent",
        "Failed to send postpone vote confirmation followUp."
      ),
    async (error) => handlePostponePipelineError(interaction, error)
  );
};
