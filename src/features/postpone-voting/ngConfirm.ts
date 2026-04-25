import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction
} from "discord.js";
import { type ResultAsync } from "neverthrow";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.js";
import { toResultAsync, fromDatabasePromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import {
  getGuardFailureReason,
  guardPostponeNgConfirmCustomId,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  guardRegisteredMemberId,
  guardSessionExists,
  guardSessionPostponeDeadlineOpen,
  guardSessionPostponeVoting,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.js";
import {
  buildPostponeNgConfirmCustomId,
  type PostponeNgConfirmCustomIdChoice
} from "../../discord/shared/customId.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";
import { postponeMessages } from "./messages.js";
import { settlePostponeVotingSession } from "../../orchestration/index.js";

interface PostponeNgConfirmPipelineStart {
  readonly interaction: ButtonInteraction;
  readonly deps: InteractionHandlerDeps;
  readonly context: AppContext;
}

interface PostponeNgConfirmPipelineParsed extends PostponeNgConfirmPipelineStart {
  readonly sessionId: string;
  readonly choice: PostponeNgConfirmCustomIdChoice;
}

interface PostponeNgConfirmPipelineReady extends PostponeNgConfirmPipelineParsed {
  readonly session: SessionRow;
  readonly memberId: string;
}

const validatePostponeNgConfirmPipeline = (
  start: PostponeNgConfirmPipelineStart
): AppResult<PostponeNgConfirmPipelineParsed, AppError> =>
  okResult(start)
    // invariant: cheap-first の検証順序を postpone_ng ハンドラ単体でも維持する。
    //   @see .github/instructions/interaction-review.instructions.md
    .andThen((current) => guardGuildId(current.interaction.guildId).map(() => current))
    .andThen((current) => guardChannelId(current.interaction.channelId).map(() => current))
    .andThen((current) => guardMemberUserId(current.interaction.user.id).map(() => current))
    .andThen((current) =>
      guardPostponeNgConfirmCustomId(current.interaction.customId).map((parsed) => ({
        ...current,
        sessionId: parsed.sessionId,
        choice: parsed.choice
      }))
    );

const loadSessionAndMemberStep = (
  context: PostponeNgConfirmPipelineParsed
): ResultAsync<PostponeNgConfirmPipelineReady, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.context.ports.sessions.findSessionById(context.sessionId),
      context.context.ports.members.findMemberIdByUserId(context.interaction.user.id)
    ]),
    "Failed to load DB state while handling postpone_ng confirm button."
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
          toResultAsync(
            guardSessionPostponeDeadlineOpen(postponeSession, context.context.clock.now())
          )
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

const recordNgAndApplyStep = (
  context: PostponeNgConfirmPipelineReady
): ResultAsync<void, AppError> =>
  fromDatabasePromise(
    context.context.ports.responses.upsertResponse({
      id: randomUUID(),
      sessionId: context.sessionId,
      memberId: context.memberId,
      choice: "POSTPONE_NG",
      answeredAt: context.context.clock.now()
    }),
    "Failed to record postpone NG response."
  )
    .andTee(() => {
      logger.info(
        {
          sessionId: context.sessionId,
          weekKey: context.session.weekKey,
          userId: context.interaction.user.id,
          memberId: context.memberId,
          choice: "POSTPONE_NG"
        },
        "Postpone NG response recorded via confirmation."
      );
    })
    .andThen(() =>
      settlePostponeVotingSession(
        context.deps.client,
        context.context,
        context.session,
        context.context.clock.now()
      )
    );

// invariant: `GuardFailureReason` → reject message 網羅は `GUARD_REASON_TO_MESSAGE` で担保。
//   ephemeral 上のボタンなので editReply でダイアログを更新し、ボタンを除去する。
const handlePostponeNgConfirmError = async (
  interaction: ButtonInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (reason) {
    if (reason === "invalid_custom_id") {
      logger.warn(
        { interactionId: interaction.id, userId: interaction.user.id },
        "Invalid custom_id for postpone_ng button."
      );
    }

    await interaction.editReply({
      content: GUARD_REASON_TO_MESSAGE[reason],
      components: []
    });
    return;
  }

  logger.error(
    {
      error,
      errorCode: error.code,
      interactionId: interaction.id,
      userId: interaction.user.id
    },
    "Failed to apply postpone NG confirmation."
  );
  await interaction.editReply({
    content: postponeMessages.ngConfirm.failed,
    components: []
  });
};

export const buildPostponeNgConfirmRow = (sessionId: string): ActionRowBuilder<ButtonBuilder> => {
  const confirmButton = new ButtonBuilder()
    .setCustomId(
      buildPostponeNgConfirmCustomId({ kind: "postpone_ng", sessionId, choice: "confirm" })
    )
    .setLabel(postponeMessages.ngConfirm.confirmButtonLabel)
    .setStyle(ButtonStyle.Danger);
  const abortButton = new ButtonBuilder()
    .setCustomId(
      buildPostponeNgConfirmCustomId({ kind: "postpone_ng", sessionId, choice: "abort" })
    )
    .setLabel(postponeMessages.ngConfirm.abortButtonLabel)
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, abortButton);
};

/**
 * Handle postpone_ng confirm/abort button from the ephemeral NG confirmation dialog.
 *
 * @remarks
 * NG 確認ダイアログは ephemeral で実行者のみ押下可。confirm で POSTPONE_NG を記録しセッションを決着、
 * abort はダイアログ更新のみ。
 * ack: `deferUpdate()` は dispatcher 側で実行済み。ここでは検証 → 状態更新 → ephemeral 更新のみ。
 */
export const handlePostponeNgConfirmButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  _ack: { readonly acknowledged: true } = { acknowledged: true }
): Promise<void> => {
  const validation = validatePostponeNgConfirmPipeline({
    interaction,
    deps,
    context: deps.context
  });
  if (validation.isErr()) {
    await handlePostponeNgConfirmError(interaction, validation.error);
    return;
  }

  const parsed = validation.value;

  if (parsed.choice === "abort") {
    await interaction.editReply({
      content: postponeMessages.ngConfirm.aborted,
      components: []
    });
    logger.info(
      { interactionId: interaction.id, userId: interaction.user.id },
      "Postpone NG confirmation aborted by user."
    );
    return;
  }

  const result = await loadSessionAndMemberStep(parsed).andThen(recordNgAndApplyStep);

  await result.match(
    async () => {
      deps.wakeScheduler?.("postpone_ng_confirmed");
      await interaction.editReply({
        content: postponeMessages.ngConfirm.confirmed,
        components: []
      });
    },
    async (error) => handlePostponeNgConfirmError(interaction, error)
  );
};
