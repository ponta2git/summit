import { describe, expect, it } from "vitest";
import { readSyncSettings } from "../../../src/commands/sync.settings.ts";
import { getSyncExitCode, isFlyEnvironment, parseSyncOptions, parseSyncReport } from "../../../src/commands/sync.protocol.ts";

const environment = { DISCORD_TOKEN: "controlled-dummy-token", DISCORD_APPLICATION_ID: "100000000000000001", DISCORD_GUILD_ID: "100000000000000002" };
const production = { production: true, check: true };

describe("command sync settings", () => {
  it("needs only explicit Discord credentials in production and ignores Bot YAML/DB settings", async () => {
    expect(await readSyncSettings(production, { ...environment, DATABASE_URL: "invalid", SUMMIT_CONFIG_YAML: "invalid: [" }))
      .toStrictEqual({ ...production, token: environment.DISCORD_TOKEN, applicationId: environment.DISCORD_APPLICATION_ID, guildId: environment.DISCORD_GUILD_ID });
  });
  it.each(Object.keys(environment))("rejects missing %s without falling back to local configuration", async key => {
    expect(await readSyncSettings(production, { ...environment, [key]: undefined, SUMMIT_CONFIG_YAML: "discord: {guildId: '100000000000000002'}" })).toBeUndefined();
  });
  it.each(["", "bad", "100000000000000001/commands", " 100000000000000001"])("rejects an invalid target ID", async id => {
    expect(await readSyncSettings(production, { ...environment, DISCORD_GUILD_ID: id })).toBeUndefined();
  });
  it("preserves the legacy development token/YAML input without requiring a database", async () => {
    const token = `${Buffer.from(environment.DISCORD_APPLICATION_ID).toString("base64url")}.dummy.signature`;
    expect(await readSyncSettings({ production: false, check: false }, { DISCORD_TOKEN: token,
      SUMMIT_CONFIG_YAML: "discord: {guildId: '100000000000000002'}" }))
      .toStrictEqual({ production: false, check: false, token, applicationId: environment.DISCORD_APPLICATION_ID, guildId: environment.DISCORD_GUILD_ID });
  });
  it("rejects malformed legacy YAML and whitespace in a token", async () => {
    expect(await readSyncSettings({ production: false, check: false }, { DISCORD_TOKEN: "dummy", SUMMIT_CONFIG_YAML: "invalid: [" })).toBeUndefined();
    expect(await readSyncSettings(production, { ...environment, DISCORD_TOKEN: "PRIVATE\nVALUE" })).toBeUndefined();
  });
  it("accepts only the documented switches", () => {
    expect(parseSyncOptions(["--production", "--check"])).toStrictEqual(production);
    expect(parseSyncOptions(["--check", "--check"])).toBeUndefined();
    expect(parseSyncOptions(["--token=PRIVATE"])).toBeUndefined();
  });
  it.each(["FLY_APP_NAME", "FLY_MACHINE_ID", "FLY_ALLOC_ID"])("refuses Fly even when %s is empty", key => {
    expect(isFlyEnvironment({ [key]: "" })).toBe(true);
    expect(isFlyEnvironment({})).toBe(false);
  });
  it("projects only safe IPC fields and provides distinct exit statuses", () => {
    expect(parseSyncReport({ status: "failed", reason: "rate_limited", retryAfterMs: 5000, token: "PRIVATE" }))
      .toStrictEqual({ status: "failed", reason: "rate_limited", retryAfterMs: 5000 });
    expect(parseSyncReport({ status: "failed", reason: "PRIVATE" })).toBeUndefined();
    expect(parseSyncReport({ status: "failed", retryAfterMs: Infinity })).toBeUndefined();
    expect([getSyncExitCode({ status: "matched" }), getSyncExitCode({ status: "synced" }),
      getSyncExitCode({ status: "different" }), getSyncExitCode({ status: "unknown" }),
      getSyncExitCode({ status: "unknown", reason: "deadline_exceeded" })]).toStrictEqual([0, 0, 2, 3, 124]);
  });
});
