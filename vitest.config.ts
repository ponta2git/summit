import { defineConfig } from "vitest/config";

// jst: env.ts import 前に TZ を確定させ、時刻依存テスト (ISO week / 締切) の再現性を担保する。
process.env.NODE_ENV = "test";
process.env.TZ = "Asia/Tokyo";
// secret: テスト用ダミー値。env.ts の zod スキーマを通すための最小値で、実値ではない。
process.env.DISCORD_TOKEN ??= "dummy-token";
process.env.DISCORD_GUILD_ID ??= "123456789012345678";
process.env.DISCORD_CHANNEL_ID ??= "223456789012345678";
process.env.MEMBER_USER_IDS ??=
  "323456789012345678,423456789012345678,523456789012345678,623456789012345678";
process.env.DATABASE_URL ??= "postgres://summit:summit@localhost:5433/summit";
process.env.POSTPONE_DEADLINE ??= "24:00";
process.env.HEALTHCHECK_PING_URL ??= "";

export default defineConfig({
  test: {
    // why: テスト間で mock 状態が漏れると race 系テストで偽陽性が出るため、常に clear + restore する。
    clearMocks: true,
    restoreMocks: true
  }
});
