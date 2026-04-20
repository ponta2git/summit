import { defineConfig } from "drizzle-kit";

// source-of-truth: drizzle-kit は DIRECT_URL (unpooled) を使う。
//   PgBouncer 経由だと migration 中の CREATE INDEX CONCURRENTLY 等が失敗する。
//   アプリ側は src/db/client.ts で DATABASE_URL (pooled) を使う二系統運用。
// secret: DIRECT_URL の実値はここに書かない。fly secrets / .env.local から注入する。
// @see docs/adr/0003-postgres-drizzle-operations.md
if (!process.env.DIRECT_URL) {
  throw new Error("DIRECT_URL is required for drizzle-kit commands.");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DIRECT_URL
  },
  casing: "snake_case",
  // why: strict/verbose を有効にしてマイグレーション生成時の曖昧さを排除し、
  //   運用者が SQL 差分をレビューしやすくする。generate → review → migrate 運用。
  // @see docs/adr/0003-postgres-drizzle-operations.md
  strict: true,
  verbose: true
});
