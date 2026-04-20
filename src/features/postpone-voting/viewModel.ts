import { env } from "../../env.js";
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
 * Pure. memberRows 省略時は memberStatuses = []（初期投稿時互換 — 【順延投票】セクション非表示）。
 * memberRows 指定時は env.MEMBER_USER_IDS 順に各メンバーの最新 response を反映する。
 * disabled / footerText は options から指定（省略時はそれぞれ false / undefined）。
 * @see docs/adr/0014-naming-dictionary-v2.md
 */
export const buildPostponeMessageViewModel = (
  session: Pick<ViewModelSessionInput, "id" | "candidateDateIso">,
  responses?: readonly ViewModelResponseInput[],
  memberRows?: readonly ViewModelMemberInput[],
  options?: { readonly disabled?: boolean; readonly footerText?: string }
): PostponeMessageViewModel => {
  // invariant: memberRows が undefined なら空配列（初期投稿時は statusLines なし）
  const memberStatuses: PostponeMemberStatus[] =
    memberRows !== undefined
      ? env.MEMBER_USER_IDS.map((userId) => {
          const member = memberRows.find((m) => m.userId === userId);
          if (!member) {
            return { userId, displayLabel: userId, state: "unanswered" as const };
          }
          // last-write-wins: 同一 memberId の最後の応答を採用（リスト末尾 = 最新）
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
    memberUserIds: env.MEMBER_USER_IDS,
    suppressMentions: env.DEV_SUPPRESS_MENTIONS,
    memberStatuses,
    disabled: options?.disabled ?? false
  };
  const footerText = options?.footerText;
  // why: exactOptionalPropertyTypes — undefined を代入すると型エラーになるため条件スプレッドで省く
  return footerText !== undefined ? { ...base, footerText } : base;
};
