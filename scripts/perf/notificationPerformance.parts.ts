import type { AnalysisCompletedNotification, Four, RankComparison } from "@momo/db/notifications";
import type postgres from "postgres";
import { capacityAnalysis } from "../verify/notificationCapacity.fixtures.ts";
import { CapacityError } from "../verify/notificationCapacity.contract.ts";

const partMatchId = (index: number): string => "界".repeat(195) + String(index).padStart(2, "0") + "::x";
const four = <T>(create: (index: 0 | 1 | 2 | 3) => T): Four<T> => [create(0), create(1), create(2), create(3)];
const maximumRanks = (values: Four<RankComparison>): Four<RankComparison> => four(index => {
  const rank = values[index];
  if (rank.before === null) { throw new CapacityError("setup_or_measurement", "part_fixture_rank"); }
  return { ...rank, before: { ...rank.before, matchCount: Number.MAX_SAFE_INTEGER },
    after: { ...rank.after, matchCount: Number.MAX_SAFE_INTEGER }, delta: 0.0001 };
});

/** Accepted adversarial input with 112 parts at the tracked probe origin.
 * Each match ID reaches 200 UTF-16 units and its encoded URL reaches 1,800.
 * This is a high-part workload, not a proof that 128 is the attainable maximum. */
export const capacityPartAnalysis = (sourceJobId: string): AnalysisCompletedNotification => {
  const base = capacityAnalysis(sourceJobId, "markdown");
  const ginjiCount = Math.floor(Number.MAX_SAFE_INTEGER / 4);
  return { ...base, data: { ...base.data,
    overall: maximumRanks(base.data.overall),
    seasons: base.data.seasons.map(season => ({ ...season, ranks: maximumRanks(season.ranks) })),
    matches: base.data.matches.map((match, index) => ({ ...match, matchId: partMatchId(index),
      matchNoInEvent: Number.MAX_SAFE_INTEGER, ginjiTotal: ginjiCount * 4,
      players: four(player => ({ ...match.players[player], ginjiCount }))
    }))
  } };
};

/** Clone the owned fixture's sources before measurement. Keep the original IDs
 * for warmup and other scenarios, and avoid (held_event_id, match_no_in_event)
 * conflicts by placing the extra rows after the original 50 matches. */
export const seedCapacityPartSources = async (client: postgres.Sql): Promise<void> => {
  const source = capacityAnalysis("performance-parts-source", "markdown");
  const sources = source.data.matches;
  await client.begin(async tx => {
    for (const [index, match] of sources.entries()) {
      const inserted = await tx`INSERT INTO matches (id, held_event_id, match_no_in_event,
        game_title_id, layout_family, map_master_id, season_master_id, owner_member_id,
        played_at, created_by_account_id)
        SELECT ${partMatchId(index)}, held_event_id, match_no_in_event + ${sources.length},
          game_title_id, layout_family, map_master_id, season_master_id, owner_member_id,
          played_at, created_by_account_id
        FROM matches WHERE id = ${match.matchId} AND game_title_id = ${source.data.gameTitleId}
        RETURNING id`;
      if (inserted.length !== 1) { throw new CapacityError("setup_or_measurement", "part_fixture_source_missing"); }
    }
  });
};
