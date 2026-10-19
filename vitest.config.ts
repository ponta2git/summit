import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

// invariant: 親プロセスの任意設定や local file を unit へ持ち込まない。
for (const key of Object.keys(process.env)) {
  if (key.startsWith("RESULT_NOTIFICATION_") || key === "FLY_IMAGE_REF" || key === "GIT_SHA") {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  NODE_ENV: "test",
  TZ: "Asia/Tokyo",
  DISCORD_TOKEN: "dummy-token",
  DATABASE_URL: "postgres://summit:summit@localhost:5433/summit",
  SUMMIT_CONFIG_YAML: readFileSync(new URL("./summit.config.example.yml", import.meta.url), "utf8")
});
export default defineConfig({
  test: {
    // why: テスト間で mock 状態が漏れると race 系テストで偽陽性が出るため、常に clear + restore する。
    clearMocks: true,
    restoreMocks: true,
    // invariant: 統合テスト (実 DB 結線) は vitest.integration.config.ts 側で実行する。
    //   `pnpm test` (ユニットのみ) に拾わせない。
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"]
  }
});
