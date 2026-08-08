import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import { type ResultAsync, okAsync } from "neverthrow";

import type { AppContext } from "../../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../../config.ts";
import type { SubmitAskResponseResult } from "../../db/ports.ts";
import type { SessionRow } from "../../db/rows.ts";
import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.ts";
import { toResultAsync, fromDatabasePromise, fromDiscordPromise } from "../../errors/result.ts";
import { logger } from "../../logger.ts";
import { askMessages } from "./messages.ts";
import { renderAskBody } from "./render.ts";
import { ASK_CUSTOM_ID_TO_DB_CHOICE, type AskDbChoice } from "./choiceMap.ts";
import { buildAskMessageViewModel } from "./viewModel.ts";
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

const validateAskPipeline = (context: AskPipelineStart): AppResult<AskPipelineParsed, AppError> =>
  okResult(context)
    // invariant: cheap-first の検証順序を ask ハンドラ単体でも維持する。
    .andThen((current) => guardGuildId(current.interaction.guildId).map(() => current))
    .andThen((current) => guardChannelId(current.interaction.channelId).map(() => current))
    .andThen((current) => guardMemberUserId(current.interaction.user.id).map(() => current))
    .andThen((current) =>
      guardAskCustomId(current.interaction.customId).map((parsed) => ({
        ...current,
        sessionId: parsed.sessionId,
        choice: ASK_CUSTOM_ID_TO_DB_CHOICE[parsed.choice]
      }))
    );

const loadSessionAndMemberStep = (context: AskPipelineParsed): ResultAsync<AskPipelineReady, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.context.ports.sessions.findSessionById(context.sessionId),
      context.context.ports.members.findMemberIdByUserId(context.interaction.user.id)
    ]),
    "Failed to load DB state while handling ask button."
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

const resolveAskCommandResult = (
  context: AskPipelineReady,
  result: SubmitAskResponseResult,
  now: Date
): ResultAsync<AskPipelineReady, AppError> => {
  switch (result.kind) {
    case "accepted_pending":
    case "transitioned":
      return okAsync(context);
    case "stale_interaction":
      logger.info(
        {
          sessionId: context.sessionId,
          interactionId: context.interaction.id,
          persistedInteractionId: result.response.sourceInteractionId
        },
        "Ignored stale ask interaction."
      );
      return okAsync(context);
    case "session_not_found":
      return toResultAsync(guardSessionExists(undefined)).map(() => context);
    case "member_not_found":
      return toResultAsync(guardRegisteredMemberId(undefined)).map(() => context);
    case "deadline_passed":
      return toResultAsync(guardSessionAskingDeadlineOpen(result.session, now)).map(
        () => context
      );
    case "closed":
      return toResultAsync(guardSessionAsking(result.session)).map(() => context);
  }
};

const recordResponseStep = (context: AskPipelineReady): ResultAsync<AskPipelineReady, AppError> => {
  const now = context.context.clock.now();
  return fromDatabasePromise(
    context.context.ports.sessionCommands.submitAskResponse({
      responseId: randomUUID(),
      sessionId: context.sessionId,
      memberId: context.memberId,
      choice: context.choice,
      sourceInteractionId: context.interaction.id,
      now,
      memberCountExpected: MEMBER_COUNT_EXPECTED
    }),
    "Failed to record ask response atomically."
  )
    .andThen((result) => resolveAskCommandResult(context, result, now))
    .andTee((current) => {
      logger.info(
        {
          sessionId: current.sessionId,
          weekKey: current.session.weekKey,
          userId: current.interaction.user.id,
          memberId: current.memberId,
          choice: current.choice
        },
        "Ask response recorded."
      );
    });
};

const refreshAskMessageStep = (context: AskPipelineReady): ResultAsync<void, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.context.ports.responses.listResponses(context.sessionId),
      context.context.ports.members.listMembers()
    ]),
    "Failed to load ask message snapshot."
  )
    .andThen(([responses, memberRows]) =>
      fromDatabasePromise(
        context.context.ports.sessions.findSessionById(context.sessionId),
        "Failed to reload session after ask response."
      ).map((freshSession) => ({
        freshSession,
        responses,
        memberRows
      }))
    )
    .andThen(({ freshSession, responses, memberRows }) => {
      if (!freshSession || !freshSession.askMessageId) {
        return okAsync(undefined);
      }

      const vm = buildAskMessageViewModel(freshSession, responses, memberRows);
      const rendered = renderAskBody(vm);
      // source-of-truth: 再描画は常に DB の最新 Session + Response から再構築する。
      return fromDiscordPromise(
        context.interaction.message.edit(rendered),
        "Failed to edit ask message after response."
      )
        .map(() => undefined)
        .orElse((error) => {
          // race: edit 失敗でも DB は巻き戻さず次 tick / 次押下で再描画して回復する。
          logger.warn(
            {
              error,
              sessionId: context.sessionId,
              messageId: freshSession.askMessageId
            },
            "Failed to edit ask message after response."
          );
          return okAsync(undefined);
        });
    });

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
  if (validation.isErr()) {
    await handleAskPipelineError(interaction, validation.error);
    return;
  }

  const parsed = validation.value;

  // why: 欠席は確定後に即セッション中止となる不可逆操作。確認ダイアログを挟み誤押下を防ぐ。
  if (parsed.choice === "ABSENT") {
    const result = await loadSessionAndMemberStep(parsed);
    await result.match(
      async (ctx) => {
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
      async (error) => handleAskPipelineError(interaction, error)
    );
    return;
  }

  const result = await loadSessionAndMemberStep(parsed)
    .andThen(recordResponseStep)
    .andThen((context) =>
      refreshAskMessageStep(context).map(() => context)
    );

  await result.match(
    async (context) => {
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
    async (error) => handleAskPipelineError(interaction, error)
  );
};
