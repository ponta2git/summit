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
  guardAbsentConfirmCustomId,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  guardRegisteredMemberId,
  guardSessionAsking,
  guardSessionAskingDeadlineOpen,
  guardSessionExists,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.ts";
import {
  buildAbsentConfirmCustomId,
  type AbsentConfirmCustomIdChoice
} from "../../discord/shared/customId.ts";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.ts";
import { askMessages } from "./messages.ts";
import {
  reflectAskingCancellation,
  settleAskingSession
} from "../../orchestration/askSettleCancel.ts";

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
): Either.Either<AbsentConfirmPipelineParsed, AppError> =>
  Either.gen(function* () {
    yield* guardGuildId(start.interaction.guildId);
    yield* guardChannelId(start.interaction.channelId);
    yield* guardMemberUserId(start.interaction.user.id);
    const parsed = yield* guardAbsentConfirmCustomId(start.interaction.customId);
    return { ...start, sessionId: parsed.sessionId, choice: parsed.choice };
  });

const loadSessionAndMemberStep = (
  context: AbsentConfirmPipelineParsed
): Effect.Effect<AbsentConfirmPipelineReady, AppError> =>
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
    yield* guardSessionAsking(existingSession);
    yield* guardSessionAskingDeadlineOpen(existingSession, context.context.clock.now());
    const registeredMemberId = yield* guardRegisteredMemberId(memberId);
    return { ...context, session: existingSession, memberId: registeredMemberId };
  });

const recordAbsentAndApplyStep = (
  context: AbsentConfirmPipelineReady
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const now = context.context.clock.now();
    const result = yield* fromDatabaseCall(
      () => context.context.ports.sessionCommands.submitAskResponse({
        responseId: randomUUID(), sessionId: context.sessionId, memberId: context.memberId,
        choice: "ABSENT", sourceInteractionId: context.interaction.id, now,
        memberCountExpected: MEMBER_COUNT_EXPECTED
      }),
      "Failed to record absent response atomically."
    );
    logger.info({ sessionId: context.sessionId, weekKey: context.session.weekKey,
      userId: context.interaction.user.id, memberId: context.memberId, choice: "ABSENT" },
      "Absent response recorded via confirmation.");
    switch (result.kind) {
      case "transitioned":
        return yield* reflectAskingCancellation(context.deps.client, context.context, result.session);
      case "stale_interaction":
      case "accepted_pending":
        return;
      case "closed":
        if (result.session.status === "CANCELLED") {
          return yield* settleAskingSession(context.deps.client, context.context, result.session.id,
            result.session.cancelReason === "saturday_cancelled" ? "saturday_cancelled" : "absent");
        }
        yield* guardSessionAsking(result.session);
        return;
      case "session_not_found":
        yield* guardSessionExists(undefined);
        return;
      case "member_not_found":
        yield* guardRegisteredMemberId(undefined);
        return;
      case "deadline_passed":
        yield* guardSessionAskingDeadlineOpen(result.session, now);
        return;
    }
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
  if (Either.isLeft(validation)) {
    await handleAbsentConfirmError(interaction, validation.left);
    return;
  }

  const parsed = validation.right;

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

  const result = await runPromiseBoundary(Effect.either(Effect.gen(function* () {
    const ready = yield* loadSessionAndMemberStep(parsed);
    yield* recordAbsentAndApplyStep(ready);
  })));

  await Either.match(result, {
    onRight: async () => {
      deps.wakeScheduler?.("ask_absent_confirmed");
      await interaction.editReply({
        content: askMessages.absentConfirm.confirmed,
        components: []
      });
    },
    onLeft: (error) => handleAbsentConfirmError(interaction, error)
  });
};
