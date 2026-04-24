import { slotKeySchema } from "../../slot.js";
import { env } from "../../env.js";
import type {
  ViewModelMemberInput,
  ViewModelResponseInput,
  ViewModelSessionInput
} from "../../discord/shared/viewModelInputs.js";
import type { AskTimeChoice } from "../../time/index.js";

export interface DecidedAnnouncementViewModel {
  readonly startTimeLabel: string;
  readonly memberUserIds: readonly string[];
  readonly suppressMentions: boolean;
  readonly memberLines: ReadonlyArray<{
    readonly displayName: string;
    readonly slotLabel: string;
  }>;
}

// invariant: SLOT → 表示ラベル @see requirements/base.md §5.1
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
 * Pure. session.decidedStartAt と env.MEMBER_USER_IDS 順で memberLines を組む。
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
