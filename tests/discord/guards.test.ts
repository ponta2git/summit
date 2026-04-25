import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  buildEphemeralReject,
  cheapFirstGuard,
  GUARD_FAILURE_REASONS,
  GUARD_REASON_TO_MESSAGE
} from "../../src/discord/shared/guards.js";
import { appConfig } from "../../src/userConfig.js";
import { memberUserId } from "../helpers/env.js";

describe("interaction guards", () => {
  it("maps every guard failure reason to a user-facing message", () => {
    for (const reason of GUARD_FAILURE_REASONS) {
      expect(typeof GUARD_REASON_TO_MESSAGE[reason]).toBe("string");
      expect(GUARD_REASON_TO_MESSAGE[reason].length).toBeGreaterThan(0);
    }
  });

  it("checks cheap-first guard failures in guild, channel, member order", () => {
    expect(cheapFirstGuard("wrong-guild", "wrong-channel", "not-member")).toBe("wrong_guild");
    expect(cheapFirstGuard(appConfig.discord.guildId, "wrong-channel", "not-member")).toBe("wrong_channel");
    expect(cheapFirstGuard(appConfig.discord.guildId, appConfig.discord.channelId, "not-member")).toBe("not_member");
    expect(cheapFirstGuard(appConfig.discord.guildId, appConfig.discord.channelId, memberUserId)).toBeUndefined();
  });

  it("builds ephemeral reject payloads", () => {
    expect(buildEphemeralReject("rejected")).toEqual({
      content: "rejected",
      flags: MessageFlags.Ephemeral
    });
  });
});
