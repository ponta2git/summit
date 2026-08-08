import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import { type ResultAsync, okAsync } from "neverthrow";

import type { AppContext } from "../../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../../config.ts";
import type { SubmitPostponeVoteResult } from "../../db/ports.ts";
import type { ResponseChoice, SessionRow } from "../../db/rows.ts";
import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.ts";
import { toResultAsync, fromDatabasePromise } from "../../errors/result.ts";
import { logger } from "../../logger.ts";
import { postponeMessages } from "./messages.ts";
import {
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  guardPostponeCustomId,
  guardRegisteredMemberId,
  guardSessionExists,
  guardSessionPostponeDeadlineOpen,
  guardSessionPostponeVoting
} from "../../discord/shared/guards.ts";
import {
  applyPostponeTransitionResult,
  buildSaturdaySessionInput
} from "../../orchestration/postponeVoting.ts";
import type { InteractionHandlerDeps } from "../../discord/shared/dispatcher.ts";
import type { PostponeCustomIdChoice } from "../../discord/shared/customId.ts";
import { buildPostponeNgConfirmRow } from "./ngConfirm.ts";
import { handlePostponePipelineError } from "./buttonError.ts";
import { refreshPostponeMessage } from "./messageRefresh.ts";

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

type AcceptedPostponeResult = Extract<
  SubmitPostponeVoteResult,
  { kind: "accepted_pending" | "stale_interaction" | "transitioned" }
>;

interface PostponePipelineRecorded extends PostponePipelineReady {
  readonly commandResult: AcceptedPostponeResult;
}

const unreachableGuardSuccess = (): never => {
  throw new Error("Expected aggregate rejection guard to fail");
};

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

const resolvePostponeCommandResult = (
  context: PostponePipelineReady,
  result: SubmitPostponeVoteResult,
  now: Date
): ResultAsync<PostponePipelineRecorded, AppError> => {
  switch (result.kind) {
    case "accepted_pending":
    case "stale_interaction":
    case "transitioned":
      return okAsync({ ...context, commandResult: result });
    case "session_not_found":
      return toResultAsync(guardSessionExists(undefined)).map(unreachableGuardSuccess);
    case "member_not_found":
      return toResultAsync(guardRegisteredMemberId(undefined)).map(unreachableGuardSuccess);
    case "deadline_passed":
      return toResultAsync(
        guardSessionPostponeDeadlineOpen(result.session, now)
      ).map(unreachableGuardSuccess);
    case "closed":
      return toResultAsync(
        guardSessionPostponeVoting(result.session)
      ).map(unreachableGuardSuccess);
  }
};

const recordResponseStep = (
  context: PostponePipelineReady
): ResultAsync<PostponePipelineRecorded, AppError> => {
  const now = context.context.clock.now();
  return fromDatabasePromise(
    context.context.ports.sessionCommands.submitPostponeVote({
      responseId: randomUUID(),
      sessionId: context.sessionId,
      memberId: context.memberId,
      choice: context.responseChoice,
      sourceInteractionId: context.interaction.id,
      now,
      memberCountExpected: MEMBER_COUNT_EXPECTED,
      saturday: buildSaturdaySessionInput(context.session)
    }),
    "Failed to record postpone response atomically."
  )
    .andThen((result) => resolvePostponeCommandResult(context, result, now))
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
};

/**
 * Handle postpone button interactions.
 *
 * @remarks
 * cheap-first validation → DB-backed pipeline。再描画は常に DB から再構築。
 * NG は不可逆なため確認 dialog を ephemeral で提示し、confirm ボタンで記録する。
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
    .andThen((context) =>
      context.commandResult.kind === "transitioned"
        ? applyPostponeTransitionResult(
            context.deps.client,
            context.context,
            context.commandResult
          ).map(() => context)
        : refreshPostponeMessage(
            context.context,
            context.interaction,
            context.sessionId
          ).map(() => context)
    );

  await result.match(
    async (context) => {
      deps.wakeScheduler?.("postpone_button_recorded");
      logger.info(
        {
          interactionId: interaction.id,
          customId: interaction.customId,
          sessionId: context.sessionId,
          weekKey: context.session.weekKey,
          userId: interaction.user.id,
          choice: context.choice
        },
        "Postpone response reflected in public message."
      );
    },
    async (error) => handlePostponePipelineError(interaction, error)
  );
};
