import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "test";
process.env.TZ = "Asia/Tokyo";
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
    clearMocks: true,
    restoreMocks: true
  }
});
