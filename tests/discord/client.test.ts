import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("createDiscordClient", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not set allowedMentions when DEV_SUPPRESS_MENTIONS is unset (production default)", async () => {
    vi.stubEnv("DEV_SUPPRESS_MENTIONS", "");
    const { createDiscordClient } = await import("../../src/discord/client.js");
    const client = createDiscordClient();

    // why: discord.js は未指定時に {} または undefined を入れる実装上の幅がある。
    //   parse:[] (全抑止) になっていないことだけを回帰テストで担保する。
    const am = client.options.allowedMentions;
    expect(am?.parse).not.toEqual([]);
  });

  it("sets allowedMentions.parse=[] when DEV_SUPPRESS_MENTIONS=true", async () => {
    vi.stubEnv("DEV_SUPPRESS_MENTIONS", "true");
    const { createDiscordClient } = await import("../../src/discord/client.js");
    const client = createDiscordClient();

    expect(client.options.allowedMentions).toEqual({ parse: [] });
  });

  it("keeps default allowedMentions when DEV_SUPPRESS_MENTIONS=false", async () => {
    vi.stubEnv("DEV_SUPPRESS_MENTIONS", "false");
    const { createDiscordClient } = await import("../../src/discord/client.js");
    const client = createDiscordClient();

    const am = client.options.allowedMentions;
    expect(am?.parse).not.toEqual([]);
  });
});
