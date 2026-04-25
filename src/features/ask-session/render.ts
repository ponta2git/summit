import {
  ActionRowBuilder,
  ButtonBuilder,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";

import {
  ASK_RESPONSE_CHOICE_TO_LABEL,
  BUTTON_LABEL_ASK_ABSENT,
  BUTTON_STYLE_ASK_ABSENT,
  BUTTON_STYLE_ASK_TIME,
  SLOT_KEY_TO_ASK_BUTTON_LABEL
} from "./constants.js";
import { askMessages } from "./messages.js";
import {
  buildCustomId,
  slotKeyFromCustomIdChoice,
  type AskCustomIdChoice
} from "../../discord/shared/customId.js";
import type { AskMessageViewModel } from "./viewModel.js";

// invariant: custom_id 末尾は `AskCustomIdChoice` の小文字値と一致させる。codec / choiceMap と同時更新。
const ASK_CHOICES = ["t2200", "t2230", "t2300", "t2330", "absent"] as const satisfies readonly AskCustomIdChoice[];

export const buildAskRow = (
  sessionId: string,
  options: { disabled?: boolean } = {}
): ActionRowBuilder<ButtonBuilder> => {
  const buttons = ASK_CHOICES.map((choice) =>
    new ButtonBuilder()
      .setCustomId(buildCustomId({ kind: "ask", sessionId, choice }))
      .setLabel(
        choice === "absent"
          ? BUTTON_LABEL_ASK_ABSENT
          : SLOT_KEY_TO_ASK_BUTTON_LABEL[slotKeyFromCustomIdChoice(choice)]
      )
      .setStyle(choice === "absent" ? BUTTON_STYLE_ASK_ABSENT : BUTTON_STYLE_ASK_TIME)
      .setDisabled(Boolean(options.disabled))
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
};

const memberLinesFromState = (
  memberUserIds: readonly string[],
  responsesByUserId: AskMessageViewModel["responsesByUserId"],
  displayNameByUserId: ReadonlyMap<string, string>
): string =>
  memberUserIds
    .map((userId) => {
      const choice = responsesByUserId.get(userId);
      const label = choice ? ASK_RESPONSE_CHOICE_TO_LABEL[choice] : askMessages.ask.unanswered;
      return `- ${displayNameByUserId.get(userId) ?? userId} : ${label}`;
    })
    .join("\n");

const buildAskContent = (vm: AskMessageViewModel): string => {
  const statusLines = memberLinesFromState(
    vm.memberUserIds,
    vm.responsesByUserId,
    vm.displayNameByUserId
  );

  // why: suppressMentions=true のとき mention 行を行ごと除去する（`filter(Boolean)` だと後続の
  //   意図した空行まで潰れるため条件付き push で組み立てる）。@see ADR-0011
  const lines: string[] = [];
  if (!vm.suppressMentions) {
    const mentions = vm.memberUserIds.map((userId) => `<@${userId}>`).join(" ");
    lines.push(mentions);
  }
  lines.push(
    askMessages.ask.body({
      dateIso: vm.candidateDateIso,
      statusLines,
      ...(vm.footer ? { extraFooter: vm.footer } : {})
    })
  );
  return lines.join("\n");
};

export const renderAskBody = (
  vm: AskMessageViewModel
): MessageCreateOptions & MessageEditOptions => ({
  content: buildAskContent(vm),
  components: [buildAskRow(vm.sessionId, { disabled: vm.disabled })]
});
