import type { AnalysisCompletedNotification, Four, RankComparison } from "@momo/db/notifications";
import type postgres from "postgres";
import { analysisNotification, rankComparisons } from "../../tests/features/result-notifications/fixtures.ts";
import { hashJsonbText } from "../../src/db/repositories/notifications.hash.ts";

const capacityId = (kind: string, index = 0): string => `capacity-${kind}-${index}-`.padEnd(200, "x");
const four = <T>(create: (index: 0 | 1 | 2 | 3) => T): Four<T> => [create(0), create(1), create(2), create(3)];

/** Fill real fields, including astral Unicode and Markdown expansion, without an
 * ignored padding property. IDs are intentionally at their accepted boundary. */
export const capacityAnalysis = (
  sourceJobId: string, mode: "normal" | "unicode" | "markdown", namePoints = 256
): AnalysisCompletedNotification => {
  const base = analysisNotification();
  const first = base.data.matches[0];
  if (!first) { throw new Error("Missing capacity fixture"); }
  const normal = mode === "normal";
  const point = mode === "unicode" ? "😀" : "*";
  const name = normal ? "週末の桃鉄" : point.repeat(namePoints);
  const displayName = normal ? "プレイヤー" : point.repeat(32);
  const comparison = (): Four<RankComparison> => {
    const ranks = rankComparisons();
    return four(index => ({ ...ranks[index], memberId: capacityId("member", index), displayName }));
  };
  return { ...base, sourceJobId, notificationId: `result:analysis_completed:${sourceJobId}`, data: {
    ...base.data, gameTitleId: capacityId("title"), gameTitleName: name, overall: comparison(),
    seasons: Array.from({ length: normal ? 1 : 16 }, (_, index) => ({
      seasonId: capacityId("season", index), seasonName: name, ranks: comparison()
    })),
    matches: Array.from({ length: normal ? 1 : 50 }, (_, index) => ({
      ...first, matchId: capacityId("match", index), heldEventId: capacityId("held"),
      matchNoInEvent: index + 1, seasonId: capacityId("season", index % 16),
      mapName: name, seasonName: name, ownerName: displayName,
      players: four(playerIndex => ({
        memberId: capacityId("member", playerIndex), displayName,
        rank: (playerIndex + 1) as 1 | 2 | 3 | 4, ginjiCount: 0
      })),
      ginjiTotal: 0, note: normal ? "週末の試合メモ。" : point.repeat(150)
    }))
  } };
};

const capacityLegacyAnalysis = (): AnalysisCompletedNotification => {
  const base = analysisNotification();
  const sourceJobId = "capacity-legacy";
  return { ...base, sourceJobId, notificationId: `result:analysis_completed:${sourceJobId}`, data: {
    ...base.data, matches: [], gameTitleName: "界" + "*".repeat(8 * 1024 * 1024 - 8_192)
  } };
};

export const canonicalCapacityBytes = async (client: postgres.Sql, value: unknown): Promise<number> => {
  const [row] = await client<{ bytes: number }[]>`SELECT octet_length(${JSON.stringify(value)}::jsonb::text) AS bytes`;
  if (!row) { throw new Error("Missing fixture measurement"); }
  return row.bytes;
};

/** PostgreSQL, rather than an approximation of its JSON formatter, picks the
 * largest field lengths below the canonical 256 KiB admission boundary. */
export const capacityNamePoints = async (client: postgres.Sql, maximumBytes: number): Promise<number> => {
  let low = 0;
  let high = 256;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = await canonicalCapacityBytes(client, capacityAnalysis("capacity-maximum-000", "unicode", middle));
    if (bytes <= maximumBytes) { low = middle; } else { high = middle - 1; }
  }
  const bytes = await canonicalCapacityBytes(client, capacityAnalysis("capacity-maximum-000", "unicode", low));
  if (bytes > maximumBytes || bytes < maximumBytes * 0.98) { throw new Error("Fixture is not near the canonical boundary"); }
  return low;
};

export const seedCapacitySources = async (client: postgres.Sql): Promise<void> => {
  const value = capacityAnalysis("capacity-seed", "normal");
  await client`INSERT INTO momo_login_accounts (id, discord_user_id, display_name)
    VALUES ('capacity-account', 'capacity-user', 'Capacity')`;
  for (let index = 0; index < 4; index++) {
    await client`INSERT INTO members (id, user_id, display_name) VALUES
      (${capacityId("member", index)}, ${`capacity-user-${index}`}, ${`Player ${index}`})`;
  }
  await client`INSERT INTO game_titles (id, name, layout_family) VALUES (${value.data.gameTitleId}, 'Capacity', 'momotetsu_2')`;
  await client`INSERT INTO map_masters (id, game_title_id, name) VALUES ('capacity-map', ${value.data.gameTitleId}, 'Capacity')`;
  for (let index = 0; index < 16; index++) {
    await client`INSERT INTO season_masters (id, game_title_id, name)
      VALUES (${capacityId("season", index)}, ${value.data.gameTitleId}, ${`Season ${index}`})`;
  }
  await client`INSERT INTO held_events (id, held_date_iso, start_at)
    VALUES (${capacityId("held")}, '2026-09-08', '2026-09-08T15:30:00Z')`;
  for (let index = 0; index < 50; index++) {
    await client`INSERT INTO matches (id, held_event_id, match_no_in_event, game_title_id, layout_family,
      map_master_id, season_master_id, owner_member_id, played_at, created_by_account_id)
      VALUES (${capacityId("match", index)}, ${capacityId("held")}, ${index + 1}, ${value.data.gameTitleId}, 'momotetsu_2',
        'capacity-map', ${capacityId("season", index % 16)}, ${capacityId("member")}, '2026-09-08T15:30:00Z', 'capacity-account')`;
  }
  await client`INSERT INTO match_drafts (id, created_by_account_id, status) VALUES ('draft-1', 'capacity-account', 'draft_ready')`;
};

export const seedLegacyCapacityNotification = async (client: postgres.Sql): Promise<number> => {
  const value = capacityLegacyAnalysis();
  const raw = JSON.stringify(value);
  const bytes = await canonicalCapacityBytes(client, value);
  if (bytes > 8 * 1024 * 1024 || bytes < 7.9 * 1024 * 1024) { throw new Error("Invalid legacy fixture size"); }
  const [normalized] = await client<{ body: string }[]>`SELECT ${raw}::jsonb::text AS body`;
  if (!normalized) { throw new Error("Missing legacy canonical fixture"); }
  await client`INSERT INTO discord_notifications (id, family, kind, dedupe_key, schema_version, payload, payload_hash)
    VALUES (${value.notificationId}, 'result', 'analysis_completed', ${value.notificationId}, 1,
      ${raw}::jsonb, ${hashJsonbText(normalized.body)})`;
  await client`INSERT INTO discord_notification_results (notification_id, kind, source_job_id, occurred_at, settings_generation)
    VALUES (${value.notificationId}, 'analysis_completed', ${value.sourceJobId}, ${value.occurredAt}, 0)`;
  return bytes;
};
