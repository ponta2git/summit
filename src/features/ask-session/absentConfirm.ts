import * as Result from "effect/Result";
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
import { runPromiseResultBoundary } from "../../runtime/effect.ts";
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
): Result.Result<AbsentConfirmPipelineParsed, AppError> =>
  Result.gen(function* () {
    yield* guardGuildId(start.interaction.guildId);
    yield* guardChannelId(start.interaction.channelId);
    yield* guardMemberUserId(start.interaction.user.id);
    const parsed = yield* guardAbsentConfirmCustomId(start.interaction.customId);
    return { ...start, sessionId: parsed.sessionId, choice: parsed.choice };
  });

const loadSessionAndMemberStep = Effect.fnUntraced(function* (
  context: AbsentConfirmPipelineParsed
): Effect.fn.Return<AbsentConfirmPipelineReady, AppError> {
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
  const existingSession = yield* Effect.fromResult(guardSessionExists(session));
  yield* Effect.fromResult(guardSessionAsking(existingSession));
  yield* Effect.fromResult(guardSessionAskingDeadlineOpen(existingSession, context.context.clock.now()));
  const registeredMemberId = yield* Effect.fromResult(guardRegisteredMemberId(memberId));
  return { ...context, session: existingSession, memberId: registeredMemberId };
});

const recordAbsentAndApplyStep = Effect.fnUntraced(function* (
  context: AbsentConfirmPipelineReady
): Effect.fn.Return<void, AppError> {
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
      context.deps.wakeScheduler?.("ask_absent_confirmed");
      return yield* reflectAskingCancellation(context.deps.client, context.context, result.session);
    case "stale_interaction":
    case "accepted_pending":
      context.deps.wakeScheduler?.("ask_absent_confirmed");
      return;
    case "closed":
      if (result.session.status === "CANCELLED") {
        yield* settleAskingSession(context.deps.client, context.context, result.session.id,
          result.session.cancelReason === "saturday_cancelled" ? "saturday_cancelled" : "absent",
          () => context.deps.wakeScheduler?.("ask_absent_confirmed"));
        return;
      }
      yield* Effect.fromResult(guardSessionAsking(result.session));
      return;
    case "session_not_found":
      yield* Effect.fromResult(guardSessionExists(undefined));
      return;
    case "member_not_found":
      yield* Effect.fromResult(guardRegisteredMemberId(undefined));
      return;
    case "deadline_passed":
      yield* Effect.fromResult(guardSessionAskingDeadlineOpen(result.session, now));
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
  if (Result.isFailure(validation)) {
    await handleAbsentConfirmError(interaction, validation.failure);
    return;
  }

  const parsed = validation.success;

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

  const result = await runPromiseResultBoundary(Effect.gen(function* () {
    const ready = yield* loadSessionAndMemberStep(parsed);
    yield* recordAbsentAndApplyStep(ready);
  }));

  await Result.match(result, {
    onSuccess: async () => {
      await interaction.editReply({
        content: askMessages.absentConfirm.confirmed,
        components: []
      });
    },
    onFailure: (error) => handleAbsentConfirmError(interaction, error)
  });
};
