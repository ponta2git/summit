import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const entry = new URL("../../src/env.ts", import.meta.url).href;
const valid = {
  DISCORD_TOKEN: "controlled-dummy-token",
  DATABASE_URL: "postgres://test:test@localhost/test",
  SUMMIT_CONFIG_YAML: "discord: {}",
  TZ: "Asia/Tokyo"
};

const run = (env: Record<string, string>, localFile?: string) => {
  const cwd = mkdtempSync(join(tmpdir(), "summit-env-"));
  try {
    if (localFile !== undefined) { writeFileSync(join(cwd, ".env.local"), localFile); }
    return spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)}); process.stdout.write("loaded");`], {
      cwd, env, encoding: "utf8", timeout: 10_000
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
};

describe("environment bootstrap", () => {
  it("uses only injected values even when a local file contains conflicting optional settings", () => {
    for (const local of [undefined, "RESULT_NOTIFICATION_TOKEN=unexpected-local-value\nTZ=UTC\n"]) {
      const result = run(valid, local);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("loaded");
      expect(result.stderr).toBe("");
    }
  });

  it("fails before completing import and reports field names without input values", () => {
    const marker = "DO-NOT-LOG-PRIVATE-VALUE";
    const result = run({ ...valid, DATABASE_URL: marker, RESULT_NOTIFICATION_TOKEN: marker });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid environment variables:");
    expect(result.stderr).toContain("DATABASE_URL:");
    expect(result.stderr).toContain("RESULT_NOTIFICATION_TOKEN:");
    expect(result.stderr).not.toContain(marker);
    expect(result.stderr).not.toContain(valid.DISCORD_TOKEN);
  });
});
