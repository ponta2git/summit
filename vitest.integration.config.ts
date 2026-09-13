import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("RESULT_NOTIFICATION_") || key === "FLY_IMAGE_REF" || key === "GIT_SHA") {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  NODE_ENV: "test", TZ: "Asia/Tokyo", DISCORD_TOKEN: "dummy-token",
  SUMMIT_CONFIG_YAML: readFileSync(new URL("./summit.config.example.yml", import.meta.url), "utf8")
});

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/integration/database.global.ts"],
    setupFiles: ["./tests/integration/database.setup.ts"],
    fileParallelism: true,
    maxWorkers: 4,
    hookTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true
  }
});
