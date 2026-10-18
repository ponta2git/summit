import type { IntegrationDb } from "./_support.ts";
import { detectIdentityLayout, identityLayout, inheritIdentityLayout, type IdentityColumn } from "../../src/db/identities.ts";

/**
 * A narrow adapter fixture, never a substitute for momo-db's full migration gate.
 * Only an empty, file-owned integration database reaches this helper. It changes
 * the consumed ID columns while retaining the shared schema's column encoders.
 */
export const prepareCanonicalAdapterFixture = async ({ db, client }: IntegrationDb): Promise<void> => {
  // Remove historical migration seed data only inside this test's owned database.
  await client`TRUNCATE members CASCADE`;
  if (await identityLayout(db) === "canonical_uuid") { return; }
  const entities = ["members", "sessions", "responses", "held_events", "match_drafts", "matches", "momo_login_accounts"];
  const tables = [...entities, "held_event_participants"];
  for (const table of tables) {
    const [row] = await client`SELECT EXISTS (SELECT 1 FROM ${client(`public.${table}`)}) AS occupied`;
    if (row?.["occupied"] !== false) { throw new Error(`Canonical adapter fixture must start empty: ${table}`); }
  }
  const constraints = await client<{ relation: string; constraint_name: string }[]>`
    SELECT source.relname AS relation, c.conname AS constraint_name FROM pg_constraint c
    JOIN pg_class source ON source.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = source.relnamespace
    JOIN pg_class target ON target.oid = c.confrelid
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND (source.relname = ANY(${tables}::text[]) OR target.relname = ANY(${tables}::text[]))`;
  for (const row of constraints) {
    await client`ALTER TABLE ${client(`public.${row.relation}`)} DROP CONSTRAINT ${client(row.constraint_name)}`;
  }
  await client`DROP INDEX IF EXISTS held_events_navigation_idx`;
  await client`DROP INDEX IF EXISTS matches_navigation_idx`;
  for (const table of entities) {
    await client`ALTER TABLE ${client(`public.${table}`)} ADD COLUMN legacy_id text NOT NULL UNIQUE`;
    await client`ALTER TABLE ${client(`public.${table}`)} ALTER COLUMN id TYPE uuid USING id::uuid`;
  }
  for (const [table, column] of [
    ["responses", "session_id"], ["responses", "member_id"], ["held_events", "session_id"],
    ["held_event_participants", "held_event_id"], ["held_event_participants", "member_id"]
  ] as const) {
    await client`ALTER TABLE ${client(`public.${table}`)} ALTER COLUMN ${client(column)} TYPE uuid USING ${client(column)}::uuid`;
  }
  await client.unsafe(`
    ALTER TABLE responses ADD FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
    ALTER TABLE responses ADD FOREIGN KEY (member_id) REFERENCES members(id);
    ALTER TABLE held_events ADD FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
    ALTER TABLE held_event_participants ADD FOREIGN KEY (held_event_id) REFERENCES held_events(id) ON DELETE CASCADE;
    ALTER TABLE held_event_participants ADD FOREIGN KEY (member_id) REFERENCES members(id);
    ALTER TABLE discord_notification_attendance ADD FOREIGN KEY (session_id) REFERENCES sessions(legacy_id) ON DELETE SET NULL;
    CREATE INDEX held_events_navigation_idx ON held_events (start_at, legacy_id COLLATE "C");
  `);
  // This intentionally incomplete fixture must not pass real startup admission.
  const columns = await client<IdentityColumn[]>`SELECT table_name, column_name, udt_name, is_nullable
    FROM information_schema.columns WHERE table_schema = 'public'`;
  try { detectIdentityLayout(columns); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "Unsupported or incomplete database identity layout") { throw error; }
    inheritIdentityLayout(db, "canonical_uuid"); return;
  }
  throw new Error("Partial adapter fixture unexpectedly passed startup admission");
};
