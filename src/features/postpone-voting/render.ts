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
} from "../../constants.js";
import { messages } from "../../messages.js";
import { buildCustomId } from "../../discord/shared/customId.js";
import type { PostponeMessageViewModel } from "../../discord/shared/viewModels.js";

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

// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
export const renderPostponeBody = (
  vm: PostponeMessageViewModel
): MessageCreateOptions => {
  const statusLines =
    vm.memberStatuses.length > 0
      ? vm.memberStatuses
          .map((ms) => {
            const label =
              ms.state === "ok" ? "OK" : ms.state === "ng" ? "NG" : "未回答";
            return `- ${ms.displayLabel}: ${label}`;
          })
          .join("\n")
      : "";

  // why: DEV_SUPPRESS_MENTIONS=true なら mention 行自体を省く。filter(Boolean) は意図した空行まで
  //   消すため条件付き push で組み立てる。
  // @see docs/adr/0011-dev-mention-suppression.md
  const lines: string[] = [];
  if (!vm.suppressMentions) {
    lines.push(vm.memberUserIds.map((id) => `<@${id}>`).join(" "));
  }
  lines.push(messages.postpone.body({ candidateDateIso: vm.candidateDateIso, statusLines }));
  if (vm.footerText) {
    lines.push("", vm.footerText);
  }

  return {
    content: lines.join("\n"),
    components: [buildPostponeRow(vm.sessionId, { disabled: vm.disabled })]
  };
};
