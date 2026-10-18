import { getTableName, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DbLike } from "./rows.ts";

export type IdentityLayout = "legacy_text" | "canonical_uuid";
type IdentityDb = Pick<DbLike, "execute">;

// The complete mutable-entity set in momo-db's canonical-identities-v1 contract.
const ENTITIES = [
  "game_titles", "held_events", "incident_masters", "map_masters", "match_drafts", "matches",
  "member_aliases", "members", "momo_login_accounts", "ocr_drafts", "ocr_jobs", "ocr_submissions",
  "responses", "season_masters", "series_analysis_campaigns", "series_analysis_job_attempts",
  "series_analysis_job_requests", "series_analysis_jobs", "series_analysis_operation_requests",
  "series_radar_candidates", "series_radar_operations", "series_radar_previews", "sessions", "source_images"
] as const;
const REFERENCES = [
  ["responses", "session_id"], ["responses", "member_id"], ["held_events", "session_id"],
  ["held_event_participants", "held_event_id"], ["held_event_participants", "member_id"]
] as const;
const ANCHORS = ["series_analysis_artifact_identities", "series_radar_basis_identities"] as const;
// Older supported DB revisions predate result-only radar/campaign tables.
// They still need every entity Summit reads and no partially converted entity.
const LEGACY_REQUIRED = ["held_events", "match_drafts", "matches", "members", "momo_login_accounts", "responses", "sessions"] as const;

export type IdentityColumn = {
  readonly table_name: string;
  readonly column_name: string;
  readonly udt_name: string;
  readonly is_nullable: string;
};

/** Refuse incomplete migrations; a running process never switches its cached layout. */
export const detectIdentityLayout = (rows: readonly IdentityColumn[]): IdentityLayout => {
  if (rows.some(row => row.column_name.startsWith("canonical_"))) {
    throw new Error("Unsupported or incomplete database identity layout");
  }
  const columns = new Map(rows.map(row => [`${row.table_name}.${row.column_name}`, row]));
  const tables = new Set(rows.map(row => row.table_name));
  const has = (table: string, column: string, type: string, required = false): boolean => {
    const actual = columns.get(`${table}.${column}`);
    return actual?.udt_name === type && (!required || actual.is_nullable === "NO");
  };
  const legacy = LEGACY_REQUIRED.every(table => has(table, "id", "text", true))
    && ENTITIES.every(table => !tables.has(table) || (has(table, "id", "text", true)
      && !columns.has(`${table}.legacy_id`)))
    && REFERENCES.every(([table, column]) => has(table, column, "text"))
    && ANCHORS.every(table => !tables.has(table))
    && !tables.has("idempotency_keys_legacy")
    && has("idempotency_keys", "key", "text", true);
  const canonical = ENTITIES.every(table => has(table, "id", "uuid", true)
    && has(table, "legacy_id", "text", true))
    && REFERENCES.every(([table, column]) => has(table, column, "uuid"))
    && ANCHORS.every(table => has(table, "id", "uuid", true)
      && has(table, "legacy_id", "text", true)
      && has(table, "game_title_id", "uuid", true)
      && has(table, "legacy_game_title_id", "text", true))
    && has("idempotency_keys_legacy", "key", "text", true)
    && has("idempotency_keys", "key", "uuid", true);
  if (!has("discord_notification_attendance", "session_id", "text")
    || (!legacy && !canonical)) {
    throw new Error("Unsupported or incomplete database identity layout");
  }
  return canonical ? "canonical_uuid" : "legacy_text";
};

const layouts = new WeakMap<object, Promise<IdentityLayout>>();

export const identityLayout = (db: IdentityDb): Promise<IdentityLayout> => {
  let pending = layouts.get(db);
  if (!pending) {
    pending = db.execute<IdentityColumn>(sql`SELECT table_name, column_name, udt_name, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public'`).then(detectIdentityLayout);
    // Cache failure as well: schema changes require a new, verified process/connection.
    layouts.set(db, pending);
  }
  return pending;
};

export const inheritIdentityLayout = (tx: IdentityDb, layout: IdentityLayout): void => {
  layouts.set(tx, Promise.resolve(layout));
};

const columnSql = (table: PgTable, column: string): SQL<string> =>
  sql<string>`${sql.identifier(getTableName(table))}.${sql.identifier(column)}`;

/** The wire ID is an exact saved alias, including case and non-UUID historical IDs. */
export const wireId = (layout: IdentityLayout, table: PgTable): SQL<string> =>
  columnSql(table, layout === "canonical_uuid" ? "legacy_id" : "id");

/** Unknown references remain unknown; never turn a caller's string into a hashed entity. */
export const nativeId = (layout: IdentityLayout, table: PgTable, value: string): SQL<string> =>
  layout === "legacy_text" ? sql<string>`${value}`
    : sql<string>`(SELECT id FROM ${table} WHERE legacy_id = ${value})`;

export const nativeIds = (layout: IdentityLayout, table: PgTable, values: readonly string[]): string[] | SQL =>
  layout === "legacy_text" ? [...values]
    : sql`(SELECT id FROM ${table} WHERE ${inArray(wireId(layout, table), [...values])})`;

export const wireReference = <T extends string | null = string>(
  layout: IdentityLayout, parent: PgTable, foreign: AnyPgColumn
): SQL<T> => layout === "legacy_text"
  ? sql<T>`${columnSql(foreign.table, foreign.name)}`
  : sql<T>`(SELECT legacy_id FROM ${parent} WHERE id = ${columnSql(foreign.table, foreign.name)})`;
