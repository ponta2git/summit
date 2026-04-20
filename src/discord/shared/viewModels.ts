// why: DB 型を UI 層から分離 (ADR-0014, naming-boundaries-audit)
// invariant: viewModel は pure (I/O なし、Date.now なし)

import { slotKeySchema } from "../../slot.js";
import { env } from "../../env.js";
import { messages, type SettleCancelReason } from "../../messages.js";
import {
  decidedStartAt,
  formatCandidateDateIso,
  parseCandidateDateIso,
  type AskTimeChoice
} from "../../time/index.js";

// --- Structural input types (decoupled from Drizzle row shapes) ---

export interface ViewModelMemberInput {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
}

export interface ViewModelResponseInput {
  readonly memberId: string;
  readonly choice: string;
}

export interface ViewModelSessionInput {
  readonly id: string;
  readonly candidateDateIso: string;
  readonly status: string;
  readonly decidedStartAt: Date | null;
}

// --- View model types (UI-relevant fields only) ---

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

export interface SettleNoticeViewModel {
  readonly cancelText: string;
  readonly memberUserIds: readonly string[];
  readonly suppressMentions: boolean;
}

export interface DecidedAnnouncementViewModel {
  readonly startTimeLabel: string;
  readonly memberUserIds: readonly string[];
  readonly suppressMentions: boolean;
  readonly memberLines: ReadonlyArray<{
    readonly displayName: string;
    readonly slotLabel: string;
  }>;
}

// --- Private helpers ---

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
      return messages.ask.footerDecided({ startTimeLabel: `${hh}:${mm}` });
    }
    return undefined;
  }
  if (session.status === "CANCELLED") {
    return messages.ask.footerCancelled;
  }
  if (session.status === "SKIPPED") {
    return messages.ask.footerSkipped;
  }
  return undefined;
};

// --- Builders ---

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

export const buildSettleNoticeViewModel = (
  reason: SettleCancelReason
): SettleNoticeViewModel => ({
  cancelText: messages.settle.cancelled(reason),
  memberUserIds: env.MEMBER_USER_IDS,
  suppressMentions: env.DEV_SUPPRESS_MENTIONS
});

// invariant: SLOT → 表示ラベル (requirements/base.md §5.1 例: "22:30")
const SLOT_TO_LABEL: Record<AskTimeChoice, string> = {
  T2200: "22:00",
  T2230: "22:30",
  T2300: "23:00",
  T2330: "23:30"
};

/**
 * Build the decided announcement view model from DB rows.
 *
 * @remarks
 * Pure. session.decidedStartAt と env.MEMBER_USER_IDS 順の response+member から memberLines を組む。
 * DECIDED セッションは全員が時間回答済み (ABSENT 不在) の invariant を features/ask-session/decide で保証しており、
 * ここでは未回答/ABSENT は "-" で fallback 表示する (直前に race で変わっても壊れないように)。
 * @see requirements/base.md §5.1
 */
export const buildDecidedAnnouncementViewModel = (
  session: Pick<ViewModelSessionInput, "decidedStartAt">,
  responses: ReadonlyArray<ViewModelResponseInput>,
  members: ReadonlyArray<ViewModelMemberInput>
): DecidedAnnouncementViewModel | undefined => {
  // invariant: DECIDED でない / decidedStartAt null の場合はメッセージを組み立てない。呼び出し側は undefined を検出して send を skip する。
  if (!session.decidedStartAt) {return undefined;}

  const hh = String(session.decidedStartAt.getHours()).padStart(2, "0");
  const mm = String(session.decidedStartAt.getMinutes()).padStart(2, "0");

  const memberById = new Map(members.map((m) => [m.id, m] as const));
  const userIdToMember = new Map(members.map((m) => [m.userId, m] as const));
  const choiceByUserId = new Map<string, string>();
  for (const response of responses) {
    const member = memberById.get(response.memberId);
    if (member) {choiceByUserId.set(member.userId, response.choice);}
  }

  const memberLines = env.MEMBER_USER_IDS.map((userId) => {
    const displayName = userIdToMember.get(userId)?.displayName ?? userId;
    const choice = choiceByUserId.get(userId);
    const parsed = choice === undefined ? undefined : slotKeySchema.safeParse(choice);
    const slotLabel =
      parsed !== undefined && parsed.success
        ? SLOT_TO_LABEL[parsed.data]
        : "-";
    return { displayName, slotLabel };
  });

  return {
    startTimeLabel: `${hh}:${mm}`,
    memberUserIds: env.MEMBER_USER_IDS,
    suppressMentions: env.DEV_SUPPRESS_MENTIONS,
    memberLines
  };
};
