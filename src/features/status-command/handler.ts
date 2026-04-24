import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { type ResultAsync } from "neverthrow";

import { OUTBOX_STRANDED_ATTEMPTS_THRESHOLD } from "../../config.js";
import type { HeldEventRow, OutboxEntry, ResponseRow, SessionRow } from "../../db/ports.js";
import {
  type AppError,
  type AppResult,
  okResult
} from "../../errors/index.js";
import { fromDatabasePromise, toResultAsync } from "../../errors/result.js";
import { logger } from "../../logger.js";
import {
  getGuardFailureReason,
  guardChannelId,
  guardGuildId,
  guardMemberUserId,
  GUARD_REASON_TO_MESSAGE
} from "../../discord/shared/guards.js";
import type { InteractionHandlerDeps } from "../../discord/shared/interactionHandlerDeps.js";
import { rejectMessages } from "../interaction-reject/messages.js";
import { buildStatusViewModel, renderStatusText } from "./viewModel.js";

interface StatusPipelineStart {
  readonly interaction: ChatInputCommandInteraction;
  readonly deps: InteractionHandlerDeps;
}

interface StatusSnapshot {
  readonly sessions: readonly SessionRow[];
  readonly strandedCancelled: readonly SessionRow[];
  readonly strandedOutbox: readonly OutboxEntry[];
  readonly responsesNested: readonly (readonly ResponseRow[])[];
  readonly heldEventsNested: readonly (HeldEventRow | undefined)[];
}

const validateStatusCommand = (
  context: StatusPipelineStart
): AppResult<StatusPipelineStart, AppError> =>
  okResult(context)
    .andThen((current) => guardGuildId(current.interaction.guildId).map(() => current))
    .andThen((current) => guardChannelId(current.interaction.channelId).map(() => current))
    .andThen((current) => guardMemberUserId(current.interaction.user.id).map(() => current));

const loadStatusSnapshot = (
  context: StatusPipelineStart
): ResultAsync<StatusSnapshot, AppError> =>
  fromDatabasePromise(
    Promise.all([
      context.deps.context.ports.sessions.findNonTerminalSessions(),
      context.deps.context.ports.sessions.findStrandedCancelledSessions(),
      context.deps.context.ports.outbox.findStranded(OUTBOX_STRANDED_ATTEMPTS_THRESHOLD)
    ]),
    "Failed to load /status session summary."
  )
    .andThen(([sessions, strandedCancelled, strandedOutbox]) =>
      fromDatabasePromise(
        Promise.all([
          Promise.all(sessions.map((s) => context.deps.context.ports.responses.listResponses(s.id))),
          Promise.all(
            sessions.map((s) =>
              s.status === "DECIDED"
                ? context.deps.context.ports.heldEvents.findBySessionId(s.id)
                : Promise.resolve(undefined)
            )
          )
        ]),
        "Failed to load /status session details."
      ).map(([responsesNested, heldEventsNested]) => ({
        sessions,
        strandedCancelled,
        strandedOutbox,
        responsesNested,
        heldEventsNested
      }))
    );

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
 * @see ADR-0032 ADR-0041
 */
export const handleStatusCommand = async (
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  const ctx = deps.context;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pipelineStart: StatusPipelineStart = { interaction, deps };
  const result = await toResultAsync(validateStatusCommand(pipelineStart))
    .andThen(loadStatusSnapshot);

  await result.match(
    async ({ sessions, strandedCancelled, strandedOutbox, responsesNested, heldEventsNested }) => {
      const now = ctx.clock.now();

      const responsesBySessionId = new Map(
        sessions.map((s, i) => [s.id, responsesNested[i] ?? []])
      );
      const heldEventBySessionId = new Map(
        sessions.flatMap((s, i) => {
          const he = heldEventsNested[i];
          return he ? [[s.id, he] as const] : [];
        })
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
    async (error) => replyStatusError(interaction, error)
  );
};
