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
 * Reads all non-terminal sessions from the DB and returns an ephemeral status summary.
 * Uses deferReply because multiple DB reads may exceed the 3-second Discord limit.
 * @see docs/adr/0032-status-command.md
 */
export const handleStatusCommand = async (
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
): Promise<void> => {
  // ack: deferReply で 3 秒制約を回避。DB read が複数あるため。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // invariant: cheap-first 順（guild → channel → member）
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

  // 並列で responses と decided sessions の heldEvent を取得する。
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
