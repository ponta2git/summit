import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

// jst: env.ts import 前に TZ を確定させ、時刻依存テスト (ISO week / 締切) の再現性を担保する。
process.env.NODE_ENV = "test";
process.env.TZ = "Asia/Tokyo";
// secret: テスト用ダミー値。env.ts の zod スキーマを通すための最小値で、実値ではない。
process.env.DISCORD_TOKEN ??= "dummy-token";
process.env.DATABASE_URL ??= "postgres://summit:summit@localhost:5433/summit";
if (!process.env.SUMMIT_CONFIG_YAML) {
  process.env.SUMMIT_CONFIG_YAML = readFileSync("summit.config.example.yml", "utf8");
}
process.env.HEALTHCHECK_PING_URL ??= "";

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
