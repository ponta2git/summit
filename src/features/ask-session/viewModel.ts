import { isSlotKey, slotKeySchema } from "../../slot.js";
import { appConfig } from "../../userConfig.js";
import { askMessages, type SettleCancelReason } from "./messages.js";
import {
  decidedStartAt,
  formatCandidateDateIso,
  parseCandidateDateIso,
  type AskTimeChoice
} from "../../time/index.js";
import type {
  ViewModelMemberInput,
  ViewModelResponseInput,
  ViewModelSessionInput
} from "../../discord/shared/viewModelInputs.js";
import type { AskResponseChoice } from "./constants.js";

export interface AskMessageViewModel {
  readonly sessionId: string;
  readonly candidateDateIso: string;
  readonly disabled: boolean;
  readonly memberUserIds: readonly string[];
  readonly responsesByUserId: ReadonlyMap<string, AskResponseChoice>;
  readonly displayNameByUserId: ReadonlyMap<string, string>;
  readonly suppressMentions: boolean;
  readonly footer: string | undefined;
}

export interface SettleNoticeViewModel {
  readonly cancelText: string;
  readonly memberUserIds: readonly string[];
  readonly suppressMentions: boolean;
}

const computeAskFooter = (
  session: ViewModelSessionInput,
  responses: ReadonlyArray<ViewModelResponseInput>,
  members: ReadonlyArray<ViewModelMemberInput>
): string | undefined => {
  if (session.status === "DECIDED" && session.decidedStartAt) {
    const timeChoices = responses
      .map((r) => r.choice)
      .filter((c): c is AskTimeChoice => slotKeySchema.safeParse(c).success);
    const start = decidedStartAt(parseCandidateDateIso(session.candidateDateIso), timeChoices);
    if (start) {
      const hh = String(start.getHours()).padStart(2, "0");
      const mm = String(start.getMinutes()).padStart(2, "0");
      return askMessages.ask.footerDecided({ startTimeLabel: `${hh}:${mm}` });
    }
    return undefined;
  }
  if (session.status === "CANCELLED") {
    return askMessages.ask.footerCancelled;
  }
  if (session.status === "SKIPPED") {
    return askMessages.ask.footerSkipped;
  }
  // why: ASKING 中に全員が時刻スロットで回答済み（absent 0 名）なら暫定開始時刻を末尾に出す。
  //   確定は締切到達まで行わない。@see requirements/base.md §4.2 §4.3
  if (session.status === "ASKING") {
    const userIdByMemberId = new Map(members.map((m) => [m.id, m.userId]));
    const choiceByUserId = new Map<string, AskResponseChoice>();
    for (const r of responses) {
      const userId = userIdByMemberId.get(r.memberId);
      if (userId && (r.choice === "ABSENT" || isSlotKey(r.choice))) {
        choiceByUserId.set(userId, r.choice);
      }
    }
    const timeChoices: AskTimeChoice[] = [];
    for (const userId of appConfig.memberUserIds) {
      const choice = choiceByUserId.get(userId);
      const parsed = choice ? slotKeySchema.safeParse(choice) : undefined;
      if (!parsed?.success) { return undefined; }
      timeChoices.push(parsed.data);
    }
    const start = decidedStartAt(parseCandidateDateIso(session.candidateDateIso), timeChoices);
    if (start) {
      const hh = String(start.getHours()).padStart(2, "0");
      const mm = String(start.getMinutes()).padStart(2, "0");
      return askMessages.ask.footerTentative({ startTimeLabel: `${hh}:${mm}` });
    }
    return undefined;
  }
  return undefined;
};

/**
 * Build the ask message view model from DB rows.
 *
 * @remarks
 * Pure. `responsesByUserId` は memberId → userId 逆引きで構築。`footer` は `session.status` に応じて
 *   自動計算される。
 */
export const buildAskMessageViewModel = (
  session: ViewModelSessionInput,
  responses: ReadonlyArray<ViewModelResponseInput>,
  members: ReadonlyArray<ViewModelMemberInput>
): AskMessageViewModel => {
  const memberLookup = new Map(members.map((m) => [m.id, m.userId]));
  const displayNameByUserId = new Map(
    members.map((m) => [m.userId, m.displayName])
  );

  const responsesByUserId = new Map<string, AskResponseChoice>();
  for (const response of responses) {
    const userId = memberLookup.get(response.memberId);
    if (userId && (response.choice === "ABSENT" || isSlotKey(response.choice))) {
      responsesByUserId.set(userId, response.choice);
    }
  }

  return {
    sessionId: session.id,
    candidateDateIso: session.candidateDateIso,
    disabled: session.status !== "ASKING",
    memberUserIds: appConfig.memberUserIds,
    responsesByUserId,
    displayNameByUserId,
    suppressMentions: appConfig.dev.suppressMentions,
    footer: computeAskFooter(session, responses, members)
  };
};

/**
 * Build the initial ask message view model (no responses yet).
 *
 * @remarks
 * Pure. 初回投稿用のため responses 空・disabled false 固定。
 */
export const buildInitialAskMessageViewModel = (
  sessionId: string,
  candidateDate: Date,
  members: ReadonlyArray<ViewModelMemberInput>
): AskMessageViewModel => ({
  sessionId,
  candidateDateIso: formatCandidateDateIso(candidateDate),
  disabled: false,
  memberUserIds: appConfig.memberUserIds,
  responsesByUserId: new Map(),
  displayNameByUserId: new Map(members.map((m) => [m.userId, m.displayName])),
  suppressMentions: appConfig.dev.suppressMentions,
  footer: undefined
});

export const buildSettleNoticeViewModel = (
  reason: SettleCancelReason
): SettleNoticeViewModel => ({
  cancelText: askMessages.settle.cancelled(reason),
  memberUserIds: appConfig.memberUserIds,
  suppressMentions: appConfig.dev.suppressMentions
});

export const renderSettleNotice = (vm: SettleNoticeViewModel): { content: string } => {
  // why: suppressMentions=true のとき mention 行を省く。単純連結だと先頭改行が残るため空文字を
  //   `filter` で除いてから join する。@see ADR-0011
  const lines = [
    vm.suppressMentions ? "" : vm.memberUserIds.map((id) => `<@${id}>`).join(" "),
    vm.cancelText
  ].filter((line) => line.length > 0);
  return { content: lines.join("\n") };
};
