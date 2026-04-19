import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageCreateOptions
} from "discord.js";

import { env } from "../env.js";
import { formatCandidateJa, parseCandidateDateIso } from "../time/index.js";
import type { SessionRow } from "../db/repositories/sessions.js";

export const buildPostponeRow = (
  sessionId: string,
  options: { disabled?: boolean } = {}
): ActionRowBuilder<ButtonBuilder> => {
  const ok = new ButtonBuilder()
    .setCustomId(`postpone:${sessionId}:ok`)
    .setLabel("翌日に順延で参加OK")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(Boolean(options.disabled));
  const ng = new ButtonBuilder()
    .setCustomId(`postpone:${sessionId}:ng`)
    .setLabel("NG")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(options.disabled));
  return new ActionRowBuilder<ButtonBuilder>().addComponents(ok, ng);
};

export const renderPostponeBody = (
  session: Pick<SessionRow, "id" | "candidateDate">
): MessageCreateOptions => {
  const candidate = parseCandidateDateIso(session.candidateDate);
  const mentions = env.MEMBER_USER_IDS.map((id) => `<@${id}>`).join(" ");

  const content = [
    mentions,
    "🔁 今週は中止になりました。翌日に順延しますか？",
    "",
    `元の候補日: ${formatCandidateJa(candidate)}`,
    "順延先: 翌日 22:00 以降",
    "回答締切: 候補日翌日 00:00 JST（押さなければ NG 扱い）",
    "",
    "全員が OK を押せば順延確定、1人でも NG / 未回答なら今週はお流れです。"
  ].join("\n");

  return {
    content,
    components: [buildPostponeRow(session.id)]
  };
};
