import { afterEach, describe, expect, it, vi } from "vitest";

describe("createDiscordClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // regression: DEV_SUPPRESS_MENTIONS=false 系 (未設定 / "" / "false") では Client-level allowedMentions が全抑止にならない。discord.js は未指定時の値に `{}`/`undefined` のぶれがあるため `parse !== []` だけを invariant として検証。
  // @see ADR-0011
  it.each<{ label: string; value: string }>([
    { label: "unset (empty)", value: "" },
    { label: "explicit false", value: "false" }
  ])(
    "does not suppress mentions when DEV_SUPPRESS_MENTIONS is $label",
    async ({ value }) => {
      vi.stubEnv("DEV_SUPPRESS_MENTIONS", value);
      vi.resetModules();
      const { createDiscordClient } = await import("../../src/discord/client.js");
      const client = createDiscordClient();

      const am = client.options.allowedMentions;
      expect(am?.parse).not.toEqual([]);
    }
  );

  it("sets allowedMentions.parse=[] when DEV_SUPPRESS_MENTIONS=true", async () => {
    vi.stubEnv("DEV_SUPPRESS_MENTIONS", "true");
    vi.resetModules();
    const { createDiscordClient } = await import("../../src/discord/client.js");
    const client = createDiscordClient();

    expect(client.options.allowedMentions).toEqual({ parse: [] });
  });
});
