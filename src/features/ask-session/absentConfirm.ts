import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction
} from "discord.js";
import { type ResultAsync, okAsync } from "neverthrow";

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
  guardAbsentConfirmCustomId,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  guardRegisteredMemberId,
  guardSessionAsking,
  guardSessionAskingDeadlineOpen,
  guardSessionExists,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.js";
import {
  buildAbsentConfirmCustomId,
  type AbsentConfirmCustomIdChoice
} from "../../discord/shared/customId.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";
import { evaluateDeadline } from "./decide.js";
import { askMessages } from "./messages.js";
import { applyDeadlineDecision } from "../../orchestration/index.js";
import { appConfig } from "../../userConfig.js";

interface AbsentConfirmPipelineStart {
  readonly interaction: ButtonInteraction;
  readonly deps: InteractionHandlerDeps;
  readonly context: AppContext;
}

interface AbsentConfirmPipelineParsed extends AbsentConfirmPipelineStart {
  readonly sessionId: string;
  readonly choice: AbsentConfirmCustomIdChoice;
}

interface AbsentConfirmPipelineReady extends AbsentConfirmPipelineParsed {
  readonly session: SessionRow;
  readonly memberId: string;
}

const validateAbsentConfirmPipeline = (
  start: AbsentConfirmPipelineStart
): AppResult<AbsentConfirmPipelineParsed, AppError> =>
  okResult(start)
    // invariant: cheap-first の検証順序を ask ハンドラ単体でも維持する。
    //   @see .github/instructions/interaction-review.instructions.md
    .andThen((current) => guardGuildId(current.interaction.guildId).map(() => current))
    .andThen((current) => guardChannelId(current.interaction.channelId).map(() => current))
    .andThen((current) => guardMemberUserId(current.interaction.user.id).map(() => current))
    .andThen((current) =>
      guardAbsentConfirmCustomId(current.interaction.customId).map((parsed) => ({
        ...current,
        sessionId: parsed.sessionId,
        choice: parsed.choice
      }))
    );

const loadSessionAndMemberStep = (
  context: AbsentConfirmPipelineParsed
): ResultAsync<AbsentConfirmPipelineReady, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.context.ports.sessions.findSessionById(context.sessionId),
      context.context.ports.members.findMemberIdByUserId(context.interaction.user.id)
    ]),
    "Failed to load DB state while handling absent confirm button."
  )
    .andThen(([session, memberId]) =>
      toResultAsync(guardSessionExists(session)).map((existingSession) => ({
        session: existingSession,
        memberId
      }))
    )
    // invariant: DB reads are parallel, but guard result precedence remains session → member.
    .andThen(({ session, memberId }) =>
      toResultAsync(guardSessionAsking(session))
        .andThen((askingSession) =>
          toResultAsync(guardSessionAskingDeadlineOpen(askingSession, context.context.clock.now()))
        )
        .map((askingSession) => ({ session: askingSession, memberId }))
    )
    .andThen(({ session, memberId }) =>
      toResultAsync(guardRegisteredMemberId(memberId)).map((registeredMemberId) => ({
        ...context,
        session,
        memberId: registeredMemberId
      }))
    );

const recordAbsentAndApplyStep = (
  context: AbsentConfirmPipelineReady
): ResultAsync<void, AppError> =>
  fromDatabasePromise(
    context.context.ports.responses.upsertResponse({
      id: randomUUID(),
      sessionId: context.sessionId,
      memberId: context.memberId,
      choice: "ABSENT",
      answeredAt: context.context.clock.now()
    }),
    "Failed to record absent response."
  )
    .andTee(() => {
      logger.info(
        {
          sessionId: context.sessionId,
          weekKey: context.session.weekKey,
          userId: context.interaction.user.id,
          memberId: context.memberId,
          choice: "ABSENT"
        },
        "Absent response recorded via confirmation."
      );
    })
    .andThen(() =>
      fromDatabasePromise(
        Promise.all([
          context.context.ports.responses.listResponses(context.sessionId),
          context.context.ports.members.listMembers()
        ]),
        "Failed to load snapshot for absent decision."
      )
    )
    .andThen(([responses, memberRows]) => {
      const activeMembers = memberRows.filter((member) =>
        appConfig.memberUserIds.includes(member.userId)
      );
      // source-of-truth: 判定ロジックは ./decide.ts。欠席が 1 件でも含まれれば cancelled。
      const decision = evaluateDeadline(context.session, responses, {
        memberCountExpected: activeMembers.length
      });
      if (decision.kind === "pending") {
        return okAsync(undefined);
      }
      return applyDeadlineDecision(context.deps.client, context.context, context.session, decision);
    });

// invariant: `GuardFailureReason` → reject message 網羅は `GUARD_REASON_TO_MESSAGE` で担保。
//   ephemeral 上のボタンなので editReply でダイアログを更新し、ボタンを除去する。
const handleAbsentConfirmError = async (
  interaction: ButtonInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (reason) {
    if (reason === "invalid_custom_id") {
      logger.warn(
        { interactionId: interaction.id, userId: interaction.user.id },
        "Invalid custom_id for ask_absent button."
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
    "Failed to apply absent confirmation."
  );
  await interaction.editReply({
    content: askMessages.absentConfirm.failed,
    components: []
  });
};

export const buildAbsentConfirmRow = (sessionId: string): ActionRowBuilder<ButtonBuilder> => {
  const confirmButton = new ButtonBuilder()
    .setCustomId(buildAbsentConfirmCustomId({ kind: "ask_absent", sessionId, choice: "confirm" }))
    .setLabel(askMessages.absentConfirm.confirmButtonLabel)
    .setStyle(ButtonStyle.Danger);
  const abortButton = new ButtonBuilder()
    .setCustomId(buildAbsentConfirmCustomId({ kind: "ask_absent", sessionId, choice: "abort" }))
    .setLabel(askMessages.absentConfirm.abortButtonLabel)
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, abortButton);
};

/**
 * Handle ask_absent confirm/abort button from the ephemeral absent confirmation dialog.
 *
 * @remarks
 * 欠席確認ダイアログは ephemeral で実行者のみ押下可。confirm で ABSENT を記録しセッションを CANCELLED に遷移、
 * abort はダイアログ更新のみ。
 * ack: `deferUpdate()` は dispatcher 側で実行済み。ここでは検証 → 状態更新 → ephemeral 更新のみ。
 */
export const handleAbsentConfirmButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  _ack: { readonly acknowledged: true } = { acknowledged: true }
): Promise<void> => {
  const validation = validateAbsentConfirmPipeline({ interaction, deps, context: deps.context });
  if (validation.isErr()) {
    await handleAbsentConfirmError(interaction, validation.error);
    return;
  }

  const parsed = validation.value;

  if (parsed.choice === "abort") {
    await interaction.editReply({
      content: askMessages.absentConfirm.aborted,
      components: []
    });
    logger.info(
      { interactionId: interaction.id, userId: interaction.user.id },
      "Absent confirmation aborted by user."
    );
    return;
  }

  const result = await loadSessionAndMemberStep(parsed).andThen(recordAbsentAndApplyStep);

  await result.match(
    async () =>
      interaction.editReply({
        content: askMessages.absentConfirm.confirmed,
        components: []
      }),
    async (error) => handleAbsentConfirmError(interaction, error)
  );
};
