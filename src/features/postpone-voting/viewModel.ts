import { appConfig } from "../../userConfig.js";
import type {
  ViewModelMemberInput,
  ViewModelResponseInput,
  ViewModelSessionInput
} from "../../discord/shared/viewModelInputs.js";

export interface PostponeMemberStatus {
  readonly userId: string;
  readonly displayLabel: string;
  readonly state: "ok" | "ng" | "unanswered";
}

export interface PostponeMessageViewModel {
  readonly sessionId: string;
  readonly candidateDateIso: string;
  readonly memberUserIds: readonly string[];
  readonly suppressMentions: boolean;
  // invariant: memberRows 省略時は [] → statusLines 省略 → 【順延投票】セクション非表示（初期投稿互換）
  readonly memberStatuses: readonly PostponeMemberStatus[];
  readonly disabled: boolean;
  readonly footerText?: string;
}

/**
 * Build a view model for the postpone voting message.
 *
 * @remarks
 * Pure. memberRows 省略時は memberStatuses=[]（初期投稿互換）。指定時は user config の member 順で
 * 各メンバーの最新 response を反映。
 * @see ADR-0014
 */
export const buildPostponeMessageViewModel = (
  session: Pick<ViewModelSessionInput, "id" | "candidateDateIso">,
  responses?: readonly ViewModelResponseInput[],
  memberRows?: readonly ViewModelMemberInput[],
  options?: { readonly disabled?: boolean; readonly footerText?: string }
): PostponeMessageViewModel => {
  const memberStatuses: PostponeMemberStatus[] =
    memberRows !== undefined
      ? appConfig.memberUserIds.map((userId) => {
          const member = memberRows.find((m) => m.userId === userId);
          if (!member) {
            return { userId, displayLabel: userId, state: "unanswered" as const };
          }
          // race: 同一 memberId の重複回答はリスト末尾 (最新) を採用し last-write-wins に収束させる。
          const memberResponses = responses?.filter((r) => r.memberId === member.id) ?? [];
          const last = memberResponses[memberResponses.length - 1];
          const state =
            last?.choice === "POSTPONE_OK"
              ? ("ok" as const)
              : last?.choice === "POSTPONE_NG"
                ? ("ng" as const)
                : ("unanswered" as const);
          return { userId, displayLabel: member.displayName, state };
        })
      : [];

  const base = {
    sessionId: session.id,
    candidateDateIso: session.candidateDateIso,
    memberUserIds: appConfig.memberUserIds,
    suppressMentions: appConfig.dev.suppressMentions,
    memberStatuses,
    disabled: options?.disabled ?? false
  };
  const footerText = options?.footerText;
  // why: exactOptionalPropertyTypes のため undefined を代入せず条件スプレッドで省く。
  return footerText !== undefined ? { ...base, footerText } : base;
};
