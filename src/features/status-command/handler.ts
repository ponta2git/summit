import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

import type { AppContext } from "../../appContext.js";
import { OUTBOX_STRANDED_ATTEMPTS_THRESHOLD } from "../../config.js";
import { logger } from "../../logger.js";
import {
  assertGuildAndChannel,
  assertMember
} from "../../discord/shared/guards.js";
import { rejectMessages } from "../interaction-reject/messages.js";
import { buildStatusViewModel, renderStatusText } from "./viewModel.js";

/**
 * Handle the /status slash command.
 *
 * @remarks
 * 非終端セッションを DB から読み上げ ephemeral で状態サマリを返す。
 * ack: 複数 DB read が 3 秒を超えうるため deferReply。
 * @see ADR-0032
 */
export const handleStatusCommand = async (
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // invariant: cheap-first 順 (guild → channel → member)
  if (
    !assertGuildAndChannel(interaction.guildId, interaction.channelId) ||
    !assertMember(interaction.user.id)
  ) {
    await interaction.editReply(rejectMessages.reject.notMember);
    return;
  }

  const now = ctx.clock.now();
  const [sessions, strandedCancelled, strandedOutbox] = await Promise.all([
    ctx.ports.sessions.findNonTerminalSessions(),
    ctx.ports.sessions.findStrandedCancelledSessions(),
    ctx.ports.outbox.findStranded(OUTBOX_STRANDED_ATTEMPTS_THRESHOLD)
  ]);

  const [responsesNested, heldEventsNested] = await Promise.all([
    Promise.all(sessions.map((s) => ctx.ports.responses.listResponses(s.id))),
    Promise.all(
      sessions.map((s) =>
        s.status === "DECIDED"
          ? ctx.ports.heldEvents.findBySessionId(s.id)
          : Promise.resolve(undefined)
      )
    )
  ]);

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
};
