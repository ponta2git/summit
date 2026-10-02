import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { parseUserConfigYaml } from "../../src/userConfig.yaml.ts";

describe("configuration YAML boundary", () => {
  it("parses ordinary YAML and bounded aliases without logging", () => {
    expect(parseUserConfigYaml("base: &base {value: 1}\ncopy: *base"))
      .toStrictEqual({ base: { value: 1 }, copy: { value: 1 } });
  });

  it.each([
    'discord: "PRIVATE-CANARY',
    "discord: !PRIVATE-CANARY value",
    "discord: value\ndiscord: PRIVATE-CANARY",
    "a: &a [1, 2]\nb: &b [*a, *a, *a, *a]\nc: &c [*b, *b, *b, *b]\nd: [*c, *c, *c, *c]",
    "x".repeat(65_537)
  ])("rejects malformed, ambiguous or excessive input with a fixed diagnostic", source => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => parseUserConfigYaml(source)).toThrow("Invalid configuration YAML");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['discord: "PRIVATE-CANARY', "discord: !PRIVATE-CANARY value"])("does not expose YAML error or warning source during startup", source => {
    const entry = new URL("../../src/userConfig.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)});`], {
      env: { DISCORD_TOKEN: "controlled-dummy-token", DATABASE_URL: "postgres://test:test@localhost/test",
        SUMMIT_CONFIG_YAML: source, TZ: "Asia/Tokyo" }, encoding: "utf8", timeout: 10_000
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Invalid user configuration: configuration YAML could not be loaded\n");
    expect(result.stderr).not.toContain("PRIVATE-CANARY");
  });
});
