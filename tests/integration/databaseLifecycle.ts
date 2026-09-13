import { randomUUID } from "node:crypto";
import type postgres from "postgres";

export const requireLocalTestUrl = (value: string | undefined): URL => {
  if (!value) { throw new Error("TEST_DATABASE_URL is required for disposable integration databases"); }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid TEST_DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]", "postgres"].includes(url.hostname)
    || url.search !== "" || url.hash !== "") {
    throw new Error("TEST_DATABASE_URL must be a local PostgreSQL URL without connection overrides");
  }
  return url;
};

export const newDatabasePrefix = (): string => `summit_test_${randomUUID().replaceAll("-", "")}`;
export const databaseUrl = (base: string, name: string): string => {
  const url = requireLocalTestUrl(base);
  url.pathname = `/${name}`;
  return url.href;
};

export const dropOwnedDatabase = async (client: postgres.Sql, name: string, prefix: string): Promise<void> => {
  if (!/^summit_test_[a-f0-9]{32}$/.test(prefix)
    || !name.startsWith(`${prefix}_`) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Refusing to drop a database outside this test run");
  }
  await client`DROP DATABASE IF EXISTS ${client(name)} WITH (FORCE)`;
};
