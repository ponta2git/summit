import type { RankComparison, RankSample } from "@momo/db/notifications";
import { escapeNotificationText } from "./text.ts";
import { assertNever } from "../../util/assertNever.ts";

const sample = (value: RankSample | null): string => {
  if (value === null) { return "前回なし"; }
  return value.averageRank === null
    ? `対象なし（${value.matchCount}試合）`
    : `${value.averageRank.toFixed(2)}位（${value.matchCount}試合）`;
};

const comparison = (rank: RankComparison): string => {
  switch (rank.comparison) {
    case "initial": return "初回";
    case "empty": return "対象なし";
    case "incomparable": return "比較不可";
    case "reused": return "再利用（比較の更新なし）";
    case "comparable": {
      if (rank.delta === null) { throw new Error("Comparable ranks require a delta."); }
      if (rank.delta === 0) { return "差分 0.00（維持）"; }
      const magnitude = Math.abs(rank.delta).toFixed(2);
      const amount = magnitude === "0.00" ? "0.01未満" : magnitude;
      return rank.delta < 0 ? `差分 -${amount}（改善）` : `差分 +${amount}（後退）`;
    }
    default: return assertNever(rank.comparison);
  }
};

export const renderNotificationRanks = (ranks: readonly RankComparison[]): string =>
  ranks.map((rank) => `${escapeNotificationText(rank.displayName)}: ${sample(rank.before)} → ${sample(rank.after)} / ${comparison(rank)}`).join("\n");
