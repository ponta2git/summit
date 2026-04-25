import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const exampleConfigYaml = readFileSync("summit.config.example.yml", "utf8");
const withSuppressMentions = (value: boolean): string =>
  exampleConfigYaml.replace("suppressMentions: false", `suppressMentions: ${value}`);

describe("createDiscordClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // regression: dev.suppressMentions=false では Client-level allowedMentions が全抑止にならない。discord.js は未指定時の値に `{}`/`undefined` のぶれがあるため `parse !== []` だけを invariant として検証。
  // @see ADR-0011
  it("does not suppress mentions when dev.suppressMentions is false", async () => {
    vi.stubEnv("SUMMIT_CONFIG_YAML", withSuppressMentions(false));
    vi.resetModules();
    const { createDiscordClient } = await import("../../src/discord/client.js");
    const client = createDiscordClient();

    const am = client.options.allowedMentions;
    expect(am?.parse).not.toEqual([]);
  });

  it("sets allowedMentions.parse=[] when dev.suppressMentions is true", async () => {
    vi.stubEnv("SUMMIT_CONFIG_YAML", withSuppressMentions(true));
    vi.resetModules();
    const { createDiscordClient } = await import("../../src/discord/client.js");
    const client = createDiscordClient();

    expect(client.options.allowedMentions).toEqual({ parse: [] });
  });
});
