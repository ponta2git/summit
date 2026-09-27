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

  it("allows only configured members and never parses role/everyone mentions", async () => {
    vi.stubEnv("SUMMIT_CONFIG_YAML", withSuppressMentions(false));
    vi.resetModules();
    const { createDiscordClient } = await import("../../src/discord/client.js");
    const { appConfig } = await import("../../src/userConfig.js");
    const client = createDiscordClient();

    const am = client.options.allowedMentions;
    expect(am).toStrictEqual({ parse: [], users: appConfig.memberUserIds, roles: [], repliedUser: false });
  });

  it("sets allowedMentions.parse=[] when dev.suppressMentions is true", async () => {
    vi.stubEnv("SUMMIT_CONFIG_YAML", withSuppressMentions(true));
    vi.resetModules();
    const { createDiscordClient } = await import("../../src/discord/client.js");
    const client = createDiscordClient();

    expect(client.options.allowedMentions).toStrictEqual({ parse: [], users: [], roles: [], repliedUser: false });
  });
});
