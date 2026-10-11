import * as Result from "effect/Result";
import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../../config.ts";
import type { SubmitAskResponseResult } from "../../db/ports.ts";
import type { SessionRow } from "../../db/rows.ts";
import type { AppError } from "../../errors/index.ts";
import { fromDatabaseCall } from "../../errors/effect.ts";
import { runPromiseResultBoundary } from "../../runtime/effect.ts";
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
import { bestEffortMessageUpdate } from "../../discord/shared/messageUpdates.ts";

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

const validateAskPipeline = (context: AskPipelineStart): Result.Result<AskPipelineParsed, AppError> =>
  Result.gen(function* () {
    yield* guardGuildId(context.interaction.guildId);
    yield* guardChannelId(context.interaction.channelId);
    yield* guardMemberUserId(context.interaction.user.id);
    const parsed = yield* guardAskCustomId(context.interaction.customId);
    return { ...context, sessionId: parsed.sessionId, choice: ASK_CUSTOM_ID_TO_DB_CHOICE[parsed.choice] };
  });

const loadSessionAndMemberStep = Effect.fnUntraced(function* (context: AskPipelineParsed): Effect.fn.Return<AskPipelineReady, AppError> {
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

const resolveAskCommandResult = Effect.fnUntraced(function* (
  context: AskPipelineReady,
  result: SubmitAskResponseResult,
  now: Date
): Effect.fn.Return<AskPipelineReady, AppError> {
  switch (result.kind) {
    case "accepted_pending":
    case "transitioned":
      return context;
    case "stale_interaction":
      logger.info({ sessionId: context.sessionId, interactionId: context.interaction.id,
        persistedInteractionId: result.response.sourceInteractionId }, "Ignored stale ask interaction.");
      return context;
    case "session_not_found":
      yield* Effect.fromResult(guardSessionExists(undefined));
      return context;
    case "member_not_found":
      yield* Effect.fromResult(guardRegisteredMemberId(undefined));
      return context;
    case "deadline_passed":
      yield* Effect.fromResult(guardSessionAskingDeadlineOpen(result.session, now));
      return context;
    case "closed":
      yield* Effect.fromResult(guardSessionAsking(result.session));
      return context;
  }
});

const recordResponseStep = Effect.fnUntraced(function* (context: AskPipelineReady): Effect.fn.Return<AskPipelineReady, AppError> {
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
  context.deps.wakeScheduler?.("ask_button_recorded");
  logger.info({ sessionId: current.sessionId, weekKey: current.session.weekKey,
    userId: current.interaction.user.id, memberId: current.memberId, choice: current.choice },
    "Ask response recorded.");
  return current;
});

const refreshAskMessageStep = (context: AskPipelineReady): Effect.Effect<void, AppError> =>
  bestEffortMessageUpdate(
    updateAskMessage(context.deps.client, context.context, context.session, context.interaction.message),
    context.sessionId,
    "ask"
  );

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
  if (Result.isFailure(validation)) {
    await handleAskPipelineError(interaction, validation.failure);
    return;
  }

  const parsed = validation.success;

  // why: 欠席は確定後に即セッション中止となる不可逆操作。確認ダイアログを挟み誤押下を防ぐ。
  if (parsed.choice === "ABSENT") {
    const result = await runPromiseResultBoundary(loadSessionAndMemberStep(parsed));
    await Result.match(result, {
      onSuccess: async (ctx) => {
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
      onFailure: (error) => handleAskPipelineError(interaction, error)
    });
    return;
  }

  const result = await runPromiseResultBoundary(Effect.gen(function* () {
    const ready = yield* loadSessionAndMemberStep(parsed);
    const context = yield* recordResponseStep(ready);
    yield* refreshAskMessageStep(context);
    return context;
  }));

  await Result.match(result, {
    onSuccess: async (context) => {
      logger.info(
        {
          userId: interaction.user.id,
          sessionId: context.sessionId,
          choice: context.choice
        },
        "Ask response reflected in public message."
      );
    },
    onFailure: (error) => handleAskPipelineError(interaction, error)
  });
};
