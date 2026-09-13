import { randomUUID } from "node:crypto";
import { afterAll, inject } from "vitest";
import postgres from "postgres";
import { databaseUrl, dropOwnedDatabase } from "./databaseLifecycle.ts";
import { closeIntegrationDbs } from "./_support.ts";

const { adminUrl, prefix, template } = inject("integrationDatabase");
const name = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => undefined });
try {
  await admin`CREATE DATABASE ${admin(name)} TEMPLATE ${admin(template)}`;
  process.env["DATABASE_URL"] = databaseUrl(adminUrl, name);
} catch (error) { await admin.end({ timeout: 5 }); throw error; }
afterAll(async () => {
  try { await closeIntegrationDbs(); await dropOwnedDatabase(admin, name, prefix); }
  finally { await admin.end({ timeout: 5 }); }
});
