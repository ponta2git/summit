import {
  ActionRowBuilder,
  ButtonBuilder,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";

import {
  ASK_BUTTON_LABELS,
  BUTTON_LABEL_ASK_ABSENT,
  BUTTON_STYLE_ASK_ABSENT,
  BUTTON_STYLE_ASK_TIME,
  CHOICE_LABEL_FOR_RESPONSE
} from "../../constants.js";
import { messages } from "../../messages.js";
import {
  slotKeyFromCustomIdChoice
} from "../../slot.js";
import { buildCustomId, type AskCustomIdChoice } from "../../discord/shared/customId.js";
import type { AskMessageViewModel } from "../../discord/shared/viewModels.js";

// invariant: Discord button の custom_id 末尾は ASK_CHOICES の小文字値と一致しなければならない。
//   customId codec / interactions.ts の ASK_CUSTOM_ID_TO_DB_CHOICE と 3 箇所同時更新。
const ASK_CHOICES = ["t2200", "t2230", "t2300", "t2330", "absent"] as const satisfies readonly AskCustomIdChoice[];

export const buildAskRow = (
  sessionId: string,
  options: { disabled?: boolean } = {}
): ActionRowBuilder<ButtonBuilder> => {
  // invariant: custom_id は customId codec (UUID + choice discriminated union) で検証される。
  //   ここで組み立てる ID は codec の round-trip を保つ必要がある。
  const buttons = ASK_CHOICES.map((choice) =>
    new ButtonBuilder()
      .setCustomId(buildCustomId({ kind: "ask", sessionId, choice }))
      .setLabel(
        choice === "absent"
          ? BUTTON_LABEL_ASK_ABSENT
          : ASK_BUTTON_LABELS[slotKeyFromCustomIdChoice(choice)]
      )
      .setStyle(choice === "absent" ? BUTTON_STYLE_ASK_ABSENT : BUTTON_STYLE_ASK_TIME)
      .setDisabled(Boolean(options.disabled))
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
};

const memberLinesFromState = (
  memberUserIds: readonly string[],
  responsesByUserId: ReadonlyMap<string, string>,
  displayNameByUserId: ReadonlyMap<string, string>
): string =>
  memberUserIds
    .map((userId) => {
      const choice = responsesByUserId.get(userId);
      const label = choice ? CHOICE_LABEL_FOR_RESPONSE[choice] ?? choice : messages.ask.unanswered;
      return `- ${displayNameByUserId.get(userId) ?? userId} : ${label}`;
    })
    .join("\n");

// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
const buildAskContent = (vm: AskMessageViewModel): string => {
  const statusLines = memberLinesFromState(
    vm.memberUserIds,
    vm.responsesByUserId,
    vm.displayNameByUserId
  );

  // why: DEV_SUPPRESS_MENTIONS=true のとき mention 行自体を除去（行ごと push しない）。
  //   filter(Boolean) だと以降の意図した空行まで潰れるため、条件付き push で組み立てる。
  // @see docs/adr/0011-dev-mention-suppression.md
  const lines: string[] = [];
  if (!vm.suppressMentions) {
    const mentions = vm.memberUserIds.map((userId) => `<@${userId}>`).join(" ");
    lines.push(mentions);
  }
  lines.push(
    messages.ask.body({
      dateIso: vm.candidateDateIso,
      statusLines,
      ...(vm.footer ? { extraFooter: vm.footer } : {})
    })
  );
  return lines.join("\n");
};

// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
export const renderAskBody = (
  vm: AskMessageViewModel
): MessageCreateOptions & MessageEditOptions => ({
  content: buildAskContent(vm),
  components: [buildAskRow(vm.sessionId, { disabled: vm.disabled })]
});
