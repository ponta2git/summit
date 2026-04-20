import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";

import { db as defaultDb } from "../../db/client.js";
import { findMemberIdByUserId, findSessionById, listMembers, listResponses, upsertResponse } from "../../db/repositories/index.js";
import { logger } from "../../logger.js";
import { messages } from "../../messages.js";
import { evaluateDeadline } from "../../domain/index.js";
import { systemClock } from "../../time/index.js";
import { renderAskBody } from "../ask/render.js";
import { buildAskMessageViewModel } from "../viewModels.js";
import { parseCustomId, type AskCustomIdChoice } from "../customId.js";
import { loadSessionOrReject } from "../guards.js";
import { applyDeadlineDecision } from "../settle.js";
import { env } from "../../env.js";
import type { InteractionHandlerDeps } from "../dispatcher.js";

const ASK_CUSTOM_ID_TO_DB_CHOICE: Record<AskCustomIdChoice, "T2200" | "T2230" | "T2300" | "T2330" | "ABSENT"> = {
  t2200: "T2200",
  t2230: "T2230",
  t2300: "T2300",
  t2330: "T2330",
  absent: "ABSENT"
};

export const handleAskButton = async (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps
): Promise<void> => {
  const db = deps.db ?? defaultDb;
  const clock = deps.clock ?? systemClock;

  const parsed = parseCustomId(interaction.customId);
  if (!parsed.success || parsed.data.kind !== "ask") {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "Invalid custom_id for ask button."
    );
    await interaction.followUp({
      content: messages.interaction.reject.invalidCustomId,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const sessionId = parsed.data.sessionId;
  const choice = ASK_CUSTOM_ID_TO_DB_CHOICE[parsed.data.choice];

  const session = await loadSessionOrReject(interaction, db, sessionId);
  if (!session) {
    return;
  }

  if (session.status !== "ASKING") {
    await interaction.followUp({
      content: messages.interaction.reject.staleSession,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const memberId = await findMemberIdByUserId(db, interaction.user.id);
  if (!memberId) {
    logger.warn(
      { interactionId: interaction.id, userId: interaction.user.id },
      "User is allowed but no matching member row."
    );
    await interaction.followUp({
      content: messages.interaction.reject.memberNotRegistered,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // idempotent: responses.(sessionId, memberId) unique 制約 + upsert で同時押下でも最終回答 1 件に収束。
  await upsertResponse(db, {
    id: randomUUID(),
    sessionId,
    memberId,
    choice,
    answeredAt: clock.now()
  });

  logger.info(
    {
      sessionId,
      weekKey: session.weekKey,
      userId: interaction.user.id,
      memberId,
      choice
    },
    "Ask response recorded."
  );

  const responses = await listResponses(db, sessionId);
  const memberRows = await listMembers(db);
  const activeMembers = memberRows.filter((m) => env.MEMBER_USER_IDS.includes(m.userId));
  // source-of-truth: 判定ロジックは domain/deadline.ts が正本。
  const decision = evaluateDeadline(session, responses, {
    memberCountExpected: activeMembers.length
  });
  if (decision.kind !== "pending") {
    await applyDeadlineDecision(deps.client, db, session, decision);
  }

  const fresh = await findSessionById(db, sessionId);
  if (!fresh || !fresh.askMessageId) {
    return;
  }

  // source-of-truth: 再描画は常に DB の最新 Session + Response から再構築する。
  try {
    // why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
    const vm = buildAskMessageViewModel(fresh, responses, memberRows);
    const rendered = renderAskBody(vm);
    await interaction.message.edit(rendered);
  } catch (error: unknown) {
    // race: edit 失敗でも DB は巻き戻さず、次 tick / 次押下で再描画して回復する。
    logger.warn(
      { error, sessionId, messageId: fresh.askMessageId },
      "Failed to edit ask message after response."
    );
  }
};
