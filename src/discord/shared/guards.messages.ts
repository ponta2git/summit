import type { GuardFailureReason } from "./guards.js";

import { rejectMessages } from "../../features/interaction-reject/messages.js";

// invariant: 全 GuardFailureReason に対して reject 文言が網羅されていることを Record<> 型で担保する。
export const GUARD_REASON_TO_MESSAGE: Record<GuardFailureReason, string> = {
  wrong_guild: rejectMessages.reject.wrongGuild,
  wrong_channel: rejectMessages.reject.wrongChannel,
  not_member: rejectMessages.reject.notMember,
  invalid_custom_id: rejectMessages.reject.invalidCustomId,
  session_not_found: rejectMessages.reject.sessionNotFound,
  session_not_asking: rejectMessages.reject.staleSession,
  session_asking_closed: rejectMessages.reject.askingClosed,
  session_not_postpone_voting: rejectMessages.reject.postponeVotingClosed,
  session_postpone_closed: rejectMessages.reject.postponeVotingClosed,
  member_not_registered: rejectMessages.reject.memberNotRegistered
};
