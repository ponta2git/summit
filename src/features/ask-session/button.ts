import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import { type ResultAsync, okAsync } from "neverthrow";

import type { AppContext } from "../../appContext.js";
import type { SessionRow } from "../../db/rows.js";
import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.js";
import { toResultAsync, fromDatabasePromise, fromDiscordPromise } from "../../errors/result.js";
import { logger } from "../../logger.js";
import { askMessages } from "./messages.js";
import { evaluateDeadline } from "./decide.js";
import { renderAskBody } from "./render.js";
import { ASK_CUSTOM_ID_TO_DB_CHOICE, type AskDbChoice } from "./choiceMap.js";
import { buildAskMessageViewModel } from "./viewModel.js";
import {
  getGuardFailureReason,
  guardAskCustomId,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  guardRegisteredMemberId,
  guardSessionAsking,
  guardSessionAskingDeadlineOpen,
  guardSessionExists,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.js";
import { applyDeadlineDecision } from "./settle.js";
import { env } from "../../env.js";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.js";
import { sendEphemeralConfirmFollowUp } from "../../discord/shared/followUp.js";

interface AskPipelineStart {
  readonly interaction: ButtonInteraction;
  readonly deps: InteractionHandlerDeps;
  readonly context: AppContext;
}

interface AskPipelineParsed extends AskPipelineStart {
  readonly sessionId: string;
  readonly choice: AskDbChoice;
}

interface AskPipelineWithSession extends AskPipelineParsed {
  readonly session: SessionRow;
}

interface AskPipelineReady extends AskPipelineWithSession {
  readonly memberId: string;
}

const validateAskPipeline = (context: AskPipelineStart): AppResult<AskPipelineParsed, AppError> =>
  okResult(context)
    // invariant: interaction-review.instructions.md の cheap-first 順序を ask ハンドラ単体でも維持する。
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

const loadSessionStep = (context: AskPipelineParsed): ResultAsync<AskPipelineWithSession, AppError> =>
  fromDatabasePromise(
    context.context.ports.sessions.findSessionById(context.sessionId),
    "Failed to load session while handling ask button."
  )
    .andThen((session) => toResultAsync(guardSessionExists(session)))
    .andThen((session) => toResultAsync(guardSessionAsking(session)))
    .andThen((session) =>
      toResultAsync(guardSessionAskingDeadlineOpen(session, context.context.clock.now()))
    )
    .map((session) => ({
      ...context,
      session
    }));

const loadMemberStep = (context: AskPipelineWithSession): ResultAsync<AskPipelineReady, AppError> =>
  fromDatabasePromise(
    context.context.ports.members.findMemberIdByUserId(context.interaction.user.id),
    "Failed to resolve member while handling ask button."
  )
    .andThen((memberId) => toResultAsync(guardRegisteredMemberId(memberId)))
    .map((memberId) => ({
      ...context,
      memberId
    }));

const recordResponseStep = (context: AskPipelineReady): ResultAsync<AskPipelineReady, AppError> =>
  fromDatabasePromise(
    context.context.ports.responses.upsertResponse({
      id: randomUUID(),
      sessionId: context.sessionId,
      memberId: context.memberId,
      choice: context.choice,
      answeredAt: context.context.clock.now()
    }),
    "Failed to record ask response."
  )
    // race: responses.(sessionId, memberId) unique 制約 + upsert で同時押下でも最終回答 1 件に収束。
    .map(() => context)
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

const applyDecisionStep = (
  context: AskPipelineReady,
  decision: ReturnType<typeof evaluateDeadline>
): ResultAsync<void, AppError> => {
  if (decision.kind === "pending") {
    return okAsync(undefined);
  }
  return applyDeadlineDecision(context.deps.client, context.context, context.session, decision);
};

const refreshAskMessageStep = (context: AskPipelineReady): ResultAsync<void, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.context.ports.responses.listResponses(context.sessionId),
      context.context.ports.members.listMembers()
    ]),
    "Failed to load ask message snapshot."
  )
    .andThen(([responses, memberRows]) => {
      const activeMembers = memberRows.filter((member) =>
        env.MEMBER_USER_IDS.includes(member.userId)
      );
      // source-of-truth: 判定ロジックは features/ask-session/decide.ts が正本。
      const decision = evaluateDeadline(context.session, responses, {
        memberCountExpected: activeMembers.length
      });

      return applyDecisionStep(context, decision).map(() => ({
        responses,
        memberRows
      }));
    })
    .andThen(({ responses, memberRows }) =>
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
          // race: edit 失敗でも DB は巻き戻さず、次 tick / 次押下で再描画して回復する。
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

// invariant: GuardFailureReason → reject message の網羅を GUARD_REASON_TO_MESSAGE で担保し、
//   reason ごとに適切な ephemeral 文言を返す。reason 不明なら再 throw して上位で捕捉する。
const handleAskPipelineError = async (
  interaction: ButtonInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (!reason) {
    throw error;
  }

  // why: invalid_custom_id / member_not_registered は内部整合性の問題として warn ログを残す
  if (reason === "invalid_custom_id") {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "Invalid custom_id for ask button."
    );
  }
  if (reason === "member_not_registered") {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "User is allowed but no matching member row."
    );
  }

  await interaction.followUp({
    content: GUARD_REASON_TO_MESSAGE[reason],
    flags: MessageFlags.Ephemeral
  });
};

/**
 * Handle ask button interactions via cheap-first validation and DB-backed pipeline composition.
 *
 * @remarks
 * `deferUpdate()` は dispatcher 側で先に実行済み。ここでは検証 → 状態更新 → 再描画だけを扱う。
 */
export const handleAskButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  // ack: component interaction の deferUpdate は dispatcher 入口で完了済み。
  // why: 分岐を局所化し、validation -> state transition -> response の pipeline を維持する。
  const pipelineStart: AskPipelineStart = {
    interaction,
    deps,
    context: deps.context
  };

  const result = await toResultAsync(validateAskPipeline(pipelineStart))
    .andThen(loadSessionStep)
    .andThen(loadMemberStep)
    .andThen(recordResponseStep)
    .andThen((context) =>
      refreshAskMessageStep(context).map(() => context)
    );

  await result.match(
    async (context) =>
      sendEphemeralConfirmFollowUp(
        interaction,
        askMessages.interaction.voteConfirmed.ask(context.choice),
        {
          userId: interaction.user.id,
          sessionId: context.sessionId,
          choice: context.choice
        },
        "voteConfirmSent",
        "Failed to send vote confirmation followUp."
      ),
    async (error) => handleAskPipelineError(interaction, error)
  );
};
