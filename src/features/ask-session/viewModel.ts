// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
// invariant: viewModel は pure (I/O なし、Date.now なし)

import { slotKeySchema } from "../../slot.js";
import { env } from "../../env.js";
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

export interface AskMessageViewModel {
  readonly sessionId: string;
  readonly candidateDateIso: string;
  readonly disabled: boolean;
  readonly memberUserIds: readonly string[];
  readonly responsesByUserId: ReadonlyMap<string, string>;
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
  responses: ReadonlyArray<ViewModelResponseInput>
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
  return undefined;
};

/**
 * Build a view model for the ask message from DB rows.
 *
 * @remarks
 * Pure. responsesByUserId は memberId → userId の逆引きを経由して構築する。
 * footer は session.status に応じて自動計算される。
 * @see docs/adr/0014-naming-dictionary-v2.md
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

  const responsesByUserId = new Map<string, string>();
  for (const response of responses) {
    const userId = memberLookup.get(response.memberId);
    if (userId) { responsesByUserId.set(userId, response.choice); }
  }

  return {
    sessionId: session.id,
    candidateDateIso: session.candidateDateIso,
    disabled: session.status !== "ASKING",
    memberUserIds: env.MEMBER_USER_IDS,
    responsesByUserId,
    displayNameByUserId,
    suppressMentions: env.DEV_SUPPRESS_MENTIONS,
    footer: computeAskFooter(session, responses)
  };
};

/**
 * Build a view model for the initial ask message (no responses yet).
 *
 * @remarks
 * Pure. 初回投稿用のため responses は空、disabled は false 固定。
 */
export const buildInitialAskMessageViewModel = (
  sessionId: string,
  candidateDate: Date,
  members: ReadonlyArray<ViewModelMemberInput>
): AskMessageViewModel => ({
  sessionId,
  candidateDateIso: formatCandidateDateIso(candidateDate),
  disabled: false,
  memberUserIds: env.MEMBER_USER_IDS,
  responsesByUserId: new Map(),
  displayNameByUserId: new Map(members.map((m) => [m.userId, m.displayName])),
  suppressMentions: env.DEV_SUPPRESS_MENTIONS,
  footer: undefined
});

export const buildSettleNoticeViewModel = (
  reason: SettleCancelReason
): SettleNoticeViewModel => ({
  cancelText: askMessages.settle.cancelled(reason),
  memberUserIds: env.MEMBER_USER_IDS,
  suppressMentions: env.DEV_SUPPRESS_MENTIONS
});

// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
export const renderSettleNotice = (vm: SettleNoticeViewModel): { content: string } => {
  // why: DEV_SUPPRESS_MENTIONS=true なら mention 行を省く。単純な `${mentions}\n${cancel}` 連結だと
  //   mentions="" のとき先頭改行が残るため、filter で空文字を除外してから join する。
  // @see docs/adr/0011-dev-mention-suppression.md
  const lines = [
    vm.suppressMentions ? "" : vm.memberUserIds.map((id) => `<@${id}>`).join(" "),
    vm.cancelText
  ].filter((line) => line.length > 0);
  return { content: lines.join("\n") };
};
