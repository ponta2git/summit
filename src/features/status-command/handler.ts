import * as Either from "effect/Either";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import * as Effect from "effect/Effect";

import { OUTBOX_STRANDED_ATTEMPTS_THRESHOLD } from "../../config.ts";
import type {
  OutboxDiagnostic,
  SessionRow,
  StatusSessionSnapshot
} from "../../db/ports.ts";
import type { AppError } from "../../errors/index.ts";
import { fromDatabaseCall } from "../../errors/effect.ts";
import { runPromiseBoundary } from "../../runtime/effect.ts";
import { logger } from "../../logger.ts";
import {
  getGuardFailureReason,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.ts";
import type { InteractionHandlerDeps } from "../../discord/shared/interactionHandlerDeps.ts";
import { rejectMessages } from "../interaction-reject/messages.ts";
import { isoWeekKey } from "../../time/index.ts";
import { buildStatusViewModel, renderStatusText } from "./viewModel.ts";

interface StatusPipelineStart {
  readonly interaction: ChatInputCommandInteraction;
  readonly deps: InteractionHandlerDeps;
}

interface StatusSnapshot {
  readonly now: Date;
  readonly sessions: readonly SessionRow[];
  readonly strandedCancelled: readonly SessionRow[];
  readonly strandedOutbox: readonly OutboxDiagnostic[];
  readonly sessionDetails: readonly StatusSessionSnapshot[];
}

const validateStatusCommand = (
  context: StatusPipelineStart
): Either.Either<StatusPipelineStart, AppError> =>
  Either.gen(function* () {
    yield* guardGuildId(context.interaction.guildId);
    yield* guardChannelId(context.interaction.channelId);
    yield* guardMemberUserId(context.interaction.user.id);
    return context;
  });

const loadStatusSnapshot = (
  context: StatusPipelineStart
): Effect.Effect<StatusSnapshot, AppError> =>
  Effect.gen(function* () {
    const now = context.deps.context.clock.now();
    const weekKey = isoWeekKey(now);
    const [statusSnapshot, strandedOutbox] = yield* Effect.all([
      fromDatabaseCall(
        () => context.deps.context.ports.status.loadCurrentWeekSnapshot(weekKey),
        "Failed to load /status snapshot."
      ),
      fromDatabaseCall(
        () => context.deps.context.ports.outbox.findStranded(OUTBOX_STRANDED_ATTEMPTS_THRESHOLD),
        "Failed to load /status outbox diagnostics."
      )
    ], { concurrency: 2 });
    return {
      now,
      sessions: statusSnapshot.sessions.map(({ session }) => session),
      strandedCancelled: statusSnapshot.strandedCancelled,
      strandedOutbox,
      sessionDetails: statusSnapshot.sessions
    };
  });

const replyStatusError = async (
  interaction: ChatInputCommandInteraction,
  error: AppError
): Promise<void> => {
  const reason = getGuardFailureReason(error);
  if (reason) {
    await interaction.editReply(GUARD_REASON_TO_MESSAGE[reason]);
    return;
  }

  logger.error(
    {
      error,
      errorCode: error.code,
      interactionId: interaction.id,
      userId: interaction.user.id
    },
    "Failed to serve /status command."
  );
  await interaction.editReply(rejectMessages.internalError);
};

/**
 * Handle the /status slash command.
 *
 * @remarks
 * 非終端セッションを DB から読み上げ ephemeral で状態サマリを返す。
 * ack: 複数 DB read が 3 秒を超えうるため deferReply。
 */
export const handleStatusCommand = async (
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pipelineStart: StatusPipelineStart = { interaction, deps };
  const result = await runPromiseBoundary(Effect.either(Effect.gen(function* () {
    const validated = yield* validateStatusCommand(pipelineStart);
    return yield* loadStatusSnapshot(validated);
  })));

  await Either.match(result, {
    onRight: async ({ now, sessions, strandedCancelled, strandedOutbox, sessionDetails }) => {
      const responsesBySessionId = new Map(
        sessionDetails.map(({ session, responses }) => [session.id, responses])
      );
      const heldEventBySessionId = new Map(
        sessionDetails.flatMap(({ session, heldEvent }) =>
          heldEvent ? [[session.id, heldEvent] as const] : []
        )
      );

      const vm = buildStatusViewModel({
        now,
        sessions,
        responsesBySessionId,
        heldEventBySessionId,
        strandedCancelledSessions: strandedCancelled,
        strandedOutboxEntries: strandedOutbox
      });

      const text = renderStatusText(vm);

      await interaction.editReply({ content: text });

      logger.info(
        {
          interactionId: interaction.id,
          userId: interaction.user.id,
          sessionCount: sessions.length,
          strandedCancelledCount: strandedCancelled.length,
          strandedOutboxCount: strandedOutbox.length,
          weekKey: vm.currentWeekKey,
          totalWarnings: vm.totalWarnings
        },
        "/status command served."
      );
    },
    onLeft: (error) => replyStatusError(interaction, error)
  });
};
