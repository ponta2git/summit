import { SLOT_TO_LABEL, slotKeySchema } from "../../slot.js";
import { appConfig } from "../../userConfig.js";
import type {
  ViewModelMemberInput,
  ViewModelResponseInput,
  ViewModelSessionInput
} from "../../discord/shared/viewModelInputs.js";

export interface DecidedAnnouncementViewModel {
  readonly startTimeLabel: string;
  readonly memberUserIds: readonly string[];
  readonly suppressMentions: boolean;
  readonly memberLines: ReadonlyArray<{
    readonly displayName: string;
    readonly slotLabel: string;
  }>;
}

/**
 * Build the decided announcement view model from DB rows.
 *
 * @remarks
 * Pure. session.decidedStartAt と user config の member 順で memberLines を組む。
 * DECIDED セッションは全員が時間回答済み (ABSENT 不在) を ask-session/decide で保証するが、
 * 直前 race 防御として未回答/ABSENT は "-" に fallback する。
 * @see requirements/base.md §5.1
 */
export const buildDecidedAnnouncementViewModel = (
  session: Pick<ViewModelSessionInput, "decidedStartAt">,
  responses: ReadonlyArray<ViewModelResponseInput>,
  members: ReadonlyArray<ViewModelMemberInput>
): DecidedAnnouncementViewModel | undefined => {
  // invariant: decidedStartAt null なら組み立てない。呼び出し側は undefined で send を skip する。
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

  const memberLines = appConfig.memberUserIds.map((userId) => {
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
    memberUserIds: appConfig.memberUserIds,
    suppressMentions: appConfig.dev.suppressMentions,
    memberLines
  };
};
