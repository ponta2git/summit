import { afterEach, describe, expect, it, vi } from "vitest";

describe("createDiscordClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // regression: DEV_SUPPRESS_MENTIONS が false 側 (未設定 / "" / "false") のとき Client-level の
  //   allowedMentions は抑止モードにならないこと。discord.js は未指定時の値に `{}` / `undefined` の
  //   ぶれがあるため、`parse !== []` (= 全抑止ではない) だけを invariant として検証する。
  // @see docs/adr/0011-dev-mention-suppression.md
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
