import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { maintenanceConnectionProof, type MaintenanceConnectionProof } from "./maintenanceConnectionProof.ts";
import { discordNotificationAttendance, discordNotificationParts, discordNotificationResults,
  discordNotificationSettings, discordNotificationTargets, discordNotifications,
  heldEventParticipants, heldEvents, members, responses, sessions } from "../db/schema.ts";

export interface MaintenanceDatabase {
  probe(): Promise<MaintenanceConnectionProof>;
  close(): Promise<void>;
}

/** Check the packaged consumer columns without reading business rows or initializing application ports. */
export const createMaintenanceDatabase = (databaseUrl: string): MaintenanceDatabase => {
  const target = new URL(databaseUrl);
  const client = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 3, idle_timeout: 5,
    max_lifetime: 60, onnotice: () => undefined,
    connection: { application_name: "summit-maintenance" } });
  return {
    probe: () => drizzle(client).transaction(async transaction => {
      // LOCAL settings survive neither commit nor a transaction pooler's reassignment.
      await transaction.execute(sql`SET LOCAL statement_timeout = '1s'`);
      await transaction.execute(sql`SET LOCAL lock_timeout = '500ms'`);
      for (const table of [members, sessions, responses, heldEvents, heldEventParticipants,
        discordNotifications, discordNotificationAttendance, discordNotificationSettings,
        discordNotificationResults, discordNotificationTargets, discordNotificationParts]) {
        await transaction.select().from(table).limit(0);
      }
      const [identity] = await transaction.execute<{ database: string; readOnly: string; filtered: boolean }>(sql`
        SELECT current_database() AS database, current_setting('transaction_read_only') AS "readOnly",
          row_security_active('drizzle.__drizzle_migrations'::regclass) AS filtered`);
      if (!identity || identity.readOnly !== "on" || identity.filtered) { throw new Error("Maintenance read-only database identity is unavailable"); }
      const ledger = await transaction.execute<{ hash: string; created_at: string }>(sql`
        SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
      return maintenanceConnectionProof(target, identity.database, ledger);
    }, { accessMode: "read only", isolationLevel: "repeatable read" }),
    close: () => client.end({ timeout: 5 })
  };
};
