interface DecidedMemberLine {
  readonly displayName: string;
  readonly slotLabel: string;
}

interface DecidedBodyParams {
  startTimeLabel: string;
  memberLines: readonly DecidedMemberLine[];
}

export const decidedMessages = {
  decided: {
    body: ({ startTimeLabel, memberLines }: DecidedBodyParams): string => {
      const maxNameLen = memberLines.reduce(
        (max, line) => Math.max(max, line.displayName.length),
        0
      );
      const lines = [
        "🎉 今週の桃鉄1年勝負は開催します！",
        "",
        `開始時刻: ${startTimeLabel}`,
        "回答内訳:",
        ...memberLines.map(
          ({ displayName, slotLabel }) =>
            `- ${displayName.padEnd(maxNameLen, " ")} : ${slotLabel}`
        )
      ];
      return lines.join("\n");
    }
  }
} as const;
