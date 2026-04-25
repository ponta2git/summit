import {
  ActionRowBuilder,
  ButtonBuilder,
  type MessageCreateOptions
} from "discord.js";

import {
  BUTTON_LABEL_POSTPONE_NG,
  BUTTON_LABEL_POSTPONE_OK,
  BUTTON_STYLE_POSTPONE_NG,
  BUTTON_STYLE_POSTPONE_OK
} from "./constants.js";
import { postponeMessages } from "./messages.js";
import { buildCustomId } from "../../discord/shared/customId.js";
import type { PostponeMessageViewModel } from "./viewModel.js";

export const buildPostponeRow = (
  sessionId: string,
  options: { disabled?: boolean } = {}
): ActionRowBuilder<ButtonBuilder> => {
  const ok = new ButtonBuilder()
    .setCustomId(buildCustomId({ kind: "postpone", sessionId, choice: "ok" }))
    .setLabel(BUTTON_LABEL_POSTPONE_OK)
    .setStyle(BUTTON_STYLE_POSTPONE_OK)
    .setDisabled(Boolean(options.disabled));
  const ng = new ButtonBuilder()
    .setCustomId(buildCustomId({ kind: "postpone", sessionId, choice: "ng" }))
    .setLabel(BUTTON_LABEL_POSTPONE_NG)
    .setStyle(BUTTON_STYLE_POSTPONE_NG)
    .setDisabled(Boolean(options.disabled));
  return new ActionRowBuilder<ButtonBuilder>().addComponents(ok, ng);
};

export const renderPostponeBody = (
  vm: PostponeMessageViewModel
): MessageCreateOptions => {
  const statusLines =
    vm.memberStatuses.length > 0
      ? vm.memberStatuses
          .map((ms) => {
            const label =
              ms.state === "ok"
                ? "明日も募集OK"
                : ms.state === "ng"
                  ? "今週はお流れ"
                  : "未回答";
            return `- ${ms.displayLabel}: ${label}`;
          })
          .join("\n")
      : "";

  // why: filter(Boolean) だと意図した空行まで消えるため条件付き push で mention 行を制御する @see ADR-0011
  const lines: string[] = [];
  if (!vm.suppressMentions) {
    lines.push(vm.memberUserIds.map((id) => `<@${id}>`).join(" "));
  }
  lines.push(postponeMessages.postpone.body({ candidateDateIso: vm.candidateDateIso, statusLines }));
  if (vm.footerText) {
    lines.push("", vm.footerText);
  }

  return {
    content: lines.join("\n"),
    components: [buildPostponeRow(vm.sessionId, { disabled: vm.disabled })]
  };
};
