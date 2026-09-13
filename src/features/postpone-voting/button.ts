import * as Either from "effect/Either";
import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import * as Effect from "effect/Effect";

import type { AppContext } from "../../appContext.ts";
import { MEMBER_COUNT_EXPECTED } from "../../config.ts";
import type { SubmitPostponeVoteResult } from "../../db/ports.ts";
import type { ResponseChoice, SessionRow } from "../../db/rows.ts";
import type { AppError } from "../../errors/index.ts";
import { fromDatabaseCall } from "../../errors/effect.ts";
import { runPromiseBoundary } from "../../runtime/effect.ts";
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
  applyPostponeTransition,
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

const validatePostponePipeline = (context: PostponePipelineStart): Either.Either<PostponePipelineParsed, AppError> =>
  Either.gen(function* () {
    yield* guardGuildId(context.interaction.guildId);
    yield* guardChannelId(context.interaction.channelId);
    yield* guardMemberUserId(context.interaction.user.id);
    const parsed = yield* guardPostponeCustomId(context.interaction.customId);
    return { ...context, sessionId: parsed.sessionId, choice: parsed.choice,
      responseChoice: POSTPONE_CUSTOM_ID_TO_DB_CHOICE[parsed.choice] };
  });

const loadSessionAndMemberStep = (context: PostponePipelineParsed): Effect.Effect<PostponePipelineReady, AppError> =>
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

const resolvePostponeCommandResult = (
  context: PostponePipelineReady,
  result: SubmitPostponeVoteResult,
  now: Date
): Effect.Effect<PostponePipelineRecorded, AppError> =>
  Effect.gen(function* () {
    switch (result.kind) {
      case "accepted_pending":
      case "stale_interaction":
      case "transitioned":
        return { ...context, commandResult: result };
      case "session_not_found":
        yield* guardSessionExists(undefined);
        return unreachableGuardSuccess();
      case "member_not_found":
        yield* guardRegisteredMemberId(undefined);
        return unreachableGuardSuccess();
      case "deadline_passed":
        yield* guardSessionPostponeDeadlineOpen(result.session, now);
        return unreachableGuardSuccess();
      case "closed":
        yield* guardSessionPostponeVoting(result.session);
        return unreachableGuardSuccess();
    }
  });

const recordResponseStep = (
  context: PostponePipelineReady
): Effect.Effect<PostponePipelineRecorded, AppError> =>
  Effect.gen(function* () {
    const now = context.context.clock.now();
    const result = yield* fromDatabaseCall(
      () => context.context.ports.sessionCommands.submitPostponeVote({
        responseId: randomUUID(), sessionId: context.sessionId, memberId: context.memberId,
        choice: context.responseChoice, sourceInteractionId: context.interaction.id, now,
        memberCountExpected: MEMBER_COUNT_EXPECTED, saturday: buildSaturdaySessionInput(context.session)
      }),
      "Failed to record postpone response atomically."
    );
    const current = yield* resolvePostponeCommandResult(context, result, now);
    logger.info({ interactionId: current.interaction.id, customId: current.interaction.customId,
      sessionId: current.sessionId, weekKey: current.session.weekKey, userId: current.interaction.user.id,
      memberId: current.memberId, choice: current.responseChoice }, "Postpone response recorded.");
    return current;
  });

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
  if (Either.isLeft(validation)) {
    await handlePostponePipelineError(interaction, validation.left);
    return;
  }

  const parsed = validation.right;

  if (parsed.choice === "ng") {
    const result = await runPromiseBoundary(Effect.either(loadSessionAndMemberStep(parsed)));
    await Either.match(result, {
      onRight: async (ctx) => {
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
      onLeft: (error) => handlePostponePipelineError(interaction, error)
    });
    return;
  }

  const result = await runPromiseBoundary(Effect.either(Effect.gen(function* () {
    const ready = yield* loadSessionAndMemberStep(parsed);
    const context = yield* recordResponseStep(ready);
    if (context.commandResult.kind === "transitioned") {
      yield* applyPostponeTransition(context.deps.client, context.context, context.commandResult);
    } else {
      yield* refreshPostponeMessage(context.deps.client, context.context, context.interaction, context.sessionId);
    }
    return context;
  })));

  await Either.match(result, {
    onRight: async (context) => {
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
    onLeft: (error) => handlePostponePipelineError(interaction, error)
  });
};
