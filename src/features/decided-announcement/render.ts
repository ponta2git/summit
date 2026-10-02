import { decidedMessages } from "./messages.ts";
import type { DecidedAnnouncementViewModel } from "./viewModel.ts";
import type { MessageCreateOptions } from "discord.js";
import { memberMentions } from "../../discord/shared/mentions.ts";

/** Render the standalone decided announcement (mentions line + body). */
export const renderDecidedAnnouncement = (
  vm: DecidedAnnouncementViewModel
): MessageCreateOptions & { readonly content: string } => {
  const body = decidedMessages.decided.body({
    startTimeLabel: vm.startTimeLabel,
    memberLines: vm.memberLines
  });
  const mentions = vm.suppressMentions ? "" : `${vm.memberUserIds.map((id) => `<@${id}>`).join(" ")}\n`;
  return {
    content: `${mentions}${body}`,
    allowedMentions: memberMentions(vm.memberUserIds, vm.suppressMentions)
  };
};
