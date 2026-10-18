import { randomUUID } from "node:crypto";
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
  const [column] = await client<{ udt_name: string }[]>`SELECT udt_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='members' AND column_name='id'`;
  if (column?.udt_name !== "text" && column?.udt_name !== "uuid") { throw new Error("Unsupported capacity fixture schema"); }
  const canonical = column.udt_name === "uuid";
  const assigned = new Map<string, string>();
  const stored = (table: string, alias: string): string => {
    if (!canonical) { return alias; }
    const key = `${table}:${alias}`;
    const nativeId = assigned.get(key) ?? randomUUID();
    assigned.set(key, nativeId);
    return nativeId;
  };
  const insert = async (table: string, alias: string, fields: Record<string, string | number>): Promise<void> => {
    const row = { id: stored(table, alias), ...(canonical ? { legacy_id: alias } : {}), ...fields };
    await client`INSERT INTO ${client(table)} ${client(row)}`;
  };
  await insert("momo_login_accounts", "capacity-account", { discord_user_id: "capacity-user", display_name: "Capacity" });
  for (let index = 0; index < 4; index++) {
    await insert("members", capacityId("member", index), { user_id: `capacity-user-${index}`, display_name: `Player ${index}` });
  }
  const title = stored("game_titles", value.data.gameTitleId);
  await insert("game_titles", value.data.gameTitleId, { name: "Capacity", layout_family: "momotetsu_2" });
  await insert("map_masters", "capacity-map", { game_title_id: title, name: "Capacity" });
  for (let index = 0; index < 16; index++) {
    await insert("season_masters", capacityId("season", index), { game_title_id: title, name: `Season ${index}` });
  }
  await insert("held_events", capacityId("held"), { held_date_iso: "2026-09-08", start_at: "2026-09-08T15:30:00Z" });
  for (let index = 0; index < 50; index++) {
    await insert("matches", capacityId("match", index), {
      held_event_id: stored("held_events", capacityId("held")), match_no_in_event: index + 1,
      ...(canonical ? { legacy_held_event_id: capacityId("held") } : {}),
      game_title_id: title, layout_family: "momotetsu_2", map_master_id: stored("map_masters", "capacity-map"),
      season_master_id: stored("season_masters", capacityId("season", index % 16)),
      owner_member_id: stored("members", capacityId("member")), played_at: "2026-09-08T15:30:00Z",
      created_by_account_id: stored("momo_login_accounts", "capacity-account")
    });
  }
  await insert("match_drafts", "draft-1", {
    created_by_account_id: stored("momo_login_accounts", "capacity-account"), status: "draft_ready"
  });
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
