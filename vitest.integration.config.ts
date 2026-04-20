import { defineConfig } from "vitest/config";

// jst: 時刻依存の統合テスト (candidate_date / deadline_at 等) の再現性を担保する。
process.env.NODE_ENV = "test";
process.env.TZ = "Asia/Tokyo";

// invariant: 統合テストは実 DB (localhost 想定) を前提にする。
//   vitest.config.ts のようなダミー DATABASE_URL 注入は行わない。
//   test 側の `INTEGRATION_DB=1` gate と localhost guard で二重防御する。
// @see docs/adr/0003-postgres-drizzle-operations.md

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // race: TRUNCATE CASCADE で干渉するため、integration は必ず直列実行。
    //   Vitest 4 では top-level の fileParallelism: false で十分 (poolOptions は撤去された)。
    fileParallelism: false,
    clearMocks: true,
    restoreMocks: true
  }
});
