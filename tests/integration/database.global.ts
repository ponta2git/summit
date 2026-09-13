import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { databaseUrl, dropOwnedDatabase, newDatabasePrefix, requireLocalTestUrl } from "./databaseLifecycle.ts";

declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabase: { adminUrl: string; prefix: string; template: string };
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env["INTEGRATION_DB"] !== "1") { throw new Error("INTEGRATION_DB=1 is required"); }
  const adminUrl = requireLocalTestUrl(process.env["TEST_DATABASE_URL"]).href;
  const prefix = newDatabasePrefix();
  const template = `${prefix}_template`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => undefined });
  const cleanup = async () => {
    try {
      const rows = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE starts_with(datname, ${`${prefix}_`})`;
      for (const row of rows) { await dropOwnedDatabase(admin, row.datname, prefix); }
    } finally { await admin.end({ timeout: 5 }); }
  };
  try {
    await admin`CREATE DATABASE ${admin(template)}`;
    const client = postgres(databaseUrl(adminUrl, template), { max: 1, prepare: false, onnotice: () => undefined });
    try { await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../../momo-db/drizzle/", import.meta.url)) }); }
    finally { await client.end({ timeout: 5 }); }
    project.provide("integrationDatabase", { adminUrl, prefix, template });
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}
