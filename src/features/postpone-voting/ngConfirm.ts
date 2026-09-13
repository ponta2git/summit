import * as Either from "effect/Either";
import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction
} from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../../config.ts";
import type { SessionRow } from "../../db/rows.ts";
import type { AppError } from "../../errors/index.ts";
import { fromDatabaseCall } from "../../errors/effect.ts";
import { runPromiseBoundary } from "../../runtime/effect.ts";
import { logger } from "../../logger.ts";
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
} from "../../discord/shared/guards.ts";
import {
  buildPostponeNgConfirmCustomId,
  type PostponeNgConfirmCustomIdChoice
} from "../../discord/shared/customId.ts";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.ts";
import { postponeMessages } from "./messages.ts";
import {
  applyPostponeTransition,
  buildSaturdaySessionInput
} from "../../orchestration/postponeVoting.ts";

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
): Either.Either<PostponeNgConfirmPipelineParsed, AppError> =>
  Either.gen(function* () {
    yield* guardGuildId(start.interaction.guildId);
    yield* guardChannelId(start.interaction.channelId);
    yield* guardMemberUserId(start.interaction.user.id);
    const parsed = yield* guardPostponeNgConfirmCustomId(start.interaction.customId);
    return { ...start, sessionId: parsed.sessionId, choice: parsed.choice };
  });

const loadSessionAndMemberStep = (
  context: PostponeNgConfirmPipelineParsed
): Effect.Effect<PostponeNgConfirmPipelineReady, AppError> =>
  Effect.gen(function* () {
    const [session, memberId] = yield* Effect.all([
      fromDatabaseCall(
        () => context.context.ports.sessions.findSessionById(context.sessionId),
        "Failed to load interaction session."
      ),
      fromDatabaseCall(
        () => context.context.ports.members.findMemberIdByUserId(context.interaction.user.id),
        "Failed to load interaction member."
      )
    ], { concurrency: 2 });
    // invariant: 読取は並列でも、検証失敗の優先順位はsession → memberを維持する。
    const existingSession = yield* guardSessionExists(session);
    yield* guardSessionPostponeVoting(existingSession);
    yield* guardSessionPostponeDeadlineOpen(existingSession, context.context.clock.now());
    const registeredMemberId = yield* guardRegisteredMemberId(memberId);
    return { ...context, session: existingSession, memberId: registeredMemberId };
  });

const recordNgAndApplyStep = (
  context: PostponeNgConfirmPipelineReady
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const now = context.context.clock.now();
    const result = yield* fromDatabaseCall(
      () => context.context.ports.sessionCommands.submitPostponeVote({
        responseId: randomUUID(), sessionId: context.sessionId, memberId: context.memberId,
        choice: "POSTPONE_NG", sourceInteractionId: context.interaction.id, now,
        memberCountExpected: MEMBER_COUNT_EXPECTED, saturday: buildSaturdaySessionInput(context.session)
      }),
      "Failed to record postpone NG response atomically."
    );
    logger.info({ sessionId: context.sessionId, weekKey: context.session.weekKey,
      userId: context.interaction.user.id, memberId: context.memberId, choice: "POSTPONE_NG" },
      "Postpone NG response recorded via confirmation.");
    switch (result.kind) {
      case "transitioned":
        return yield* applyPostponeTransition(context.deps.client, context.context, result);
      case "stale_interaction":
      case "accepted_pending":
        return;
      case "closed":
        yield* guardSessionPostponeVoting(result.session);
        return;
      case "session_not_found":
        yield* guardSessionExists(undefined);
        return;
      case "member_not_found":
        yield* guardRegisteredMemberId(undefined);
        return;
      case "deadline_passed":
        yield* guardSessionPostponeDeadlineOpen(result.session, now);
        return;
    }
  });

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
  if (Either.isLeft(validation)) {
    await handlePostponeNgConfirmError(interaction, validation.left);
    return;
  }

  const parsed = validation.right;

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

  const result = await runPromiseBoundary(Effect.either(Effect.gen(function* () {
    const ready = yield* loadSessionAndMemberStep(parsed);
    yield* recordNgAndApplyStep(ready);
  })));

  await Either.match(result, {
    onRight: async () => {
      deps.wakeScheduler?.("postpone_ng_confirmed");
      await interaction.editReply({
        content: postponeMessages.ngConfirm.confirmed,
        components: []
      });
    },
    onLeft: (error) => handlePostponeNgConfirmError(interaction, error)
  });
};
