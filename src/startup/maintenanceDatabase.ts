import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { discordNotificationAttendance, discordNotificationParts, discordNotificationResults,
  discordNotificationSettings, discordNotificationTargets, discordNotifications,
  heldEventParticipants, heldEvents, members, responses, sessions } from "../db/schema.ts";

export interface MaintenanceDatabase {
  probe(): Promise<string>;
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
      const [identity] = await transaction.execute<{ database: string; role: string; readOnly: string }>(sql`
        SELECT current_database() AS database, current_user AS role, current_setting('transaction_read_only') AS "readOnly"`);
      if (!identity || identity.readOnly !== "on") { throw new Error("Maintenance read-only database identity is unavailable"); }
      // Do not return connection values. This fingerprint is an operator comparison aid, not target attestation.
      return createHash("sha256").update(JSON.stringify([
        target.hostname, target.port || "5432", identity.database, identity.role
      ])).digest("hex");
    }, { accessMode: "read only" }),
    close: () => client.end({ timeout: 5 })
  };
};
