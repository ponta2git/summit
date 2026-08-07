import { decidedMessages } from "./messages.js";
import type { DecidedAnnouncementViewModel } from "./viewModel.js";

/** Render the standalone decided announcement (mentions line + body). */
export const renderDecidedAnnouncement = (
  vm: DecidedAnnouncementViewModel
): { content: string } => {
  const body = decidedMessages.decided.body({
    startTimeLabel: vm.startTimeLabel,
    memberLines: vm.memberLines
  });
  if (vm.suppressMentions) {
    return { content: body };
  }
  const mentions = vm.memberUserIds.map((id) => `<@${id}>`).join(" ");
  return { content: `${mentions}\n${body}` };
};
