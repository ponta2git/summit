import { MEMBER_COUNT_EXPECTED } from "../config.js";

const LEGACY_DISPLAY_NAME_BY_POSITION = {
  1: "いーゆー",
  2: "おーたか",
  3: "あかねまみ",
  4: "ぽんた"
} as const;

type LegacyDisplayNamePosition = keyof typeof LEGACY_DISPLAY_NAME_BY_POSITION;

export interface MemberReconcileInput {
  userId: string;
  displayName: string;
  syncDisplayName: boolean;
}

const toLegacyDisplayNamePosition = (index: number): LegacyDisplayNamePosition => {
  const position = index + 1;
  if (!(position in LEGACY_DISPLAY_NAME_BY_POSITION)) {
    throw new Error(`MEMBER_USER_IDS must contain exactly ${MEMBER_COUNT_EXPECTED} members.`);
  }
  return position as LegacyDisplayNamePosition;
};

export const buildMemberReconcileInputs = (
  memberUserIds: readonly string[],
  memberDisplayNames?: readonly string[]
): ReadonlyArray<MemberReconcileInput> => {
  if (memberUserIds.length !== MEMBER_COUNT_EXPECTED) {
    throw new Error(`MEMBER_USER_IDS must contain exactly ${MEMBER_COUNT_EXPECTED} members.`);
  }

  if (memberDisplayNames && memberDisplayNames.length !== MEMBER_COUNT_EXPECTED) {
    throw new Error(`MEMBER_DISPLAY_NAMES must contain exactly ${MEMBER_COUNT_EXPECTED} members.`);
  }

  // invariant: env は identity (user_id), DB は付随データ (display_name)
  return memberUserIds.map((userId, index) => {
    if (!userId) {
      throw new Error(`MEMBER_USER_IDS must contain exactly ${MEMBER_COUNT_EXPECTED} members.`);
    }

    // why: display_name は DB に移送 (ADR-0012)
    const displayName = memberDisplayNames?.[index]
      ?? LEGACY_DISPLAY_NAME_BY_POSITION[toLegacyDisplayNamePosition(index)];

    return {
      userId,
      displayName,
      syncDisplayName: memberDisplayNames !== undefined
    };
  });
};
