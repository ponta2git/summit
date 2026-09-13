import * as Either from "effect/Either";
import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../../config.ts";
import type { SubmitAskResponseResult } from "../../db/ports.ts";
import type { SessionRow } from "../../db/rows.ts";
import type { AppError } from "../../errors/index.ts";
import { fromDatabaseCall } from "../../errors/effect.ts";
import { runPromiseBoundary } from "../../runtime/effect.ts";
import { logger } from "../../logger.ts";
import { askMessages } from "./messages.ts";
import { updateAskMessage } from "./messageEditor.ts";
import { ASK_CUSTOM_ID_TO_DB_CHOICE, type AskDbChoice } from "./choiceMap.ts";
import {
  guardAskCustomId,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  guardRegisteredMemberId,
  guardSessionAsking,
  guardSessionAskingDeadlineOpen,
  guardSessionExists
} from "../../discord/shared/guards.ts";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.ts";
import { buildAbsentConfirmRow } from "./absentConfirm.ts";
import { handleAskPipelineError } from "./buttonError.ts";

interface AskPipelineStart {
  readonly interaction: ButtonInteraction;
  readonly deps: InteractionHandlerDeps;
  readonly context: AppContext;
}

interface AskPipelineParsed extends AskPipelineStart {
  readonly sessionId: string;
  readonly choice: AskDbChoice;
}

interface AskPipelineReady extends AskPipelineParsed {
  readonly session: SessionRow;
  readonly memberId: string;
}

const validateAskPipeline = (context: AskPipelineStart): Either.Either<AskPipelineParsed, AppError> =>
  Either.gen(function* () {
    yield* guardGuildId(context.interaction.guildId);
    yield* guardChannelId(context.interaction.channelId);
    yield* guardMemberUserId(context.interaction.user.id);
    const parsed = yield* guardAskCustomId(context.interaction.customId);
    return { ...context, sessionId: parsed.sessionId, choice: ASK_CUSTOM_ID_TO_DB_CHOICE[parsed.choice] };
  });

const loadSessionAndMemberStep = (context: AskPipelineParsed): Effect.Effect<AskPipelineReady, AppError> =>
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

const resolveAskCommandResult = (
  context: AskPipelineReady,
  result: SubmitAskResponseResult,
  now: Date
): Effect.Effect<AskPipelineReady, AppError> =>
  Effect.gen(function* () {
    switch (result.kind) {
      case "accepted_pending":
      case "transitioned":
        return context;
      case "stale_interaction":
        logger.info({ sessionId: context.sessionId, interactionId: context.interaction.id,
          persistedInteractionId: result.response.sourceInteractionId }, "Ignored stale ask interaction.");
        return context;
      case "session_not_found":
        yield* guardSessionExists(undefined);
        return context;
      case "member_not_found":
        yield* guardRegisteredMemberId(undefined);
        return context;
      case "deadline_passed":
        yield* guardSessionAskingDeadlineOpen(result.session, now);
        return context;
      case "closed":
        yield* guardSessionAsking(result.session);
        return context;
    }
  });

const recordResponseStep = (context: AskPipelineReady): Effect.Effect<AskPipelineReady, AppError> =>
  Effect.gen(function* () {
    const now = context.context.clock.now();
    const result = yield* fromDatabaseCall(
      () => context.context.ports.sessionCommands.submitAskResponse({
        responseId: randomUUID(), sessionId: context.sessionId, memberId: context.memberId,
        choice: context.choice, sourceInteractionId: context.interaction.id, now,
        memberCountExpected: MEMBER_COUNT_EXPECTED
      }),
      "Failed to record ask response atomically."
    );
    const current = yield* resolveAskCommandResult(context, result, now);
    logger.info({ sessionId: current.sessionId, weekKey: current.session.weekKey,
      userId: current.interaction.user.id, memberId: current.memberId, choice: current.choice },
      "Ask response recorded.");
    return current;
  });

const refreshAskMessageStep = (context: AskPipelineReady): Effect.Effect<void, AppError> =>
  updateAskMessage(context.deps.client, context.context, context.session, context.interaction.message)
    .pipe(Effect.catchAll(error => {
      if (error.code !== "DISCORD_API") { return Effect.fail(error); }
      logger.warn({ error, sessionId: context.sessionId }, "Failed to edit ask message after response.");
      return Effect.void;
    }));

/**
 * Handle ask button interactions via cheap-first validation and DB-backed pipeline composition.
 *
 * @remarks
 * ack: `deferUpdate()` は dispatcher 側で実行済み。ここでは検証 → 状態更新 → 再描画のみ。
 * ABSENT 選択時は不可逆なため ephemeral 確認ダイアログを表示し、確定は ask_absent ハンドラに委譲する。
 */
export const handleAskButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  _ack: { readonly acknowledged: true } = { acknowledged: true }
): Promise<void> => {
  const pipelineStart: AskPipelineStart = {
    interaction,
    deps,
    context: deps.context
  };

  const validation = validateAskPipeline(pipelineStart);
  if (Either.isLeft(validation)) {
    await handleAskPipelineError(interaction, validation.left);
    return;
  }

  const parsed = validation.right;

  // why: 欠席は確定後に即セッション中止となる不可逆操作。確認ダイアログを挟み誤押下を防ぐ。
  if (parsed.choice === "ABSENT") {
    const result = await runPromiseBoundary(Effect.either(loadSessionAndMemberStep(parsed)));
    await Either.match(result, {
      onRight: async (ctx) => {
        await interaction.followUp({
          content: askMessages.absentConfirm.prompt,
          components: [buildAbsentConfirmRow(ctx.sessionId)],
          flags: MessageFlags.Ephemeral
        });
        logger.info(
          {
            sessionId: ctx.sessionId,
            weekKey: ctx.session.weekKey,
            userId: interaction.user.id
          },
          "Absent confirmation dialog shown."
        );
      },
      onLeft: (error) => handleAskPipelineError(interaction, error)
    });
    return;
  }

  const result = await runPromiseBoundary(Effect.either(Effect.gen(function* () {
    const ready = yield* loadSessionAndMemberStep(parsed);
    const context = yield* recordResponseStep(ready);
    yield* refreshAskMessageStep(context);
    return context;
  })));

  await Either.match(result, {
    onRight: async (context) => {
      deps.wakeScheduler?.("ask_button_recorded");
      logger.info(
        {
          userId: interaction.user.id,
          sessionId: context.sessionId,
          choice: context.choice
        },
        "Ask response reflected in public message."
      );
    },
    onLeft: (error) => handleAskPipelineError(interaction, error)
  });
};
