const DISPLAY_NAMES = ["いーゆー", "おーたか", "あかねまみ", "ぽんた"] as const;

export interface MemberLine {
  userId: string;
  displayName: (typeof DISPLAY_NAMES)[number];
}

export const buildMemberLines = (memberUserIds: readonly string[]): ReadonlyArray<MemberLine> => {
  if (memberUserIds.length !== DISPLAY_NAMES.length) {
    throw new Error("MEMBER_USER_IDS must contain exactly 4 members.");
  }

  return DISPLAY_NAMES.map((displayName, index) => {
    const userId = memberUserIds[index];
    if (!userId) {
      throw new Error("MEMBER_USER_IDS must contain exactly 4 members.");
    }
    return {
      userId,
      displayName
    };
  });
};
