import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  buildEphemeralReject,
  cheapFirstGuard,
  GUARD_REASON_TO_MESSAGE
} from "../../src/discord/shared/guards.js";
import { rejectMessages } from "../../src/features/interaction-reject/messages.js";
import { appConfig } from "../../src/userConfig.js";
import { memberUserId } from "../helpers/env.js";

describe("interaction guards", () => {
  it("maps every guard failure reason to a user-facing message", () => {
    expect(GUARD_REASON_TO_MESSAGE).toStrictEqual({
      wrong_guild: rejectMessages.reject.wrongGuild,
      wrong_channel: rejectMessages.reject.wrongChannel,
      not_member: rejectMessages.reject.notMember,
      invalid_custom_id: rejectMessages.reject.invalidCustomId,
      session_not_found: rejectMessages.reject.sessionNotFound,
      session_not_asking: rejectMessages.reject.staleSession,
      session_asking_closed: rejectMessages.reject.askingClosed,
      session_not_postpone_voting: rejectMessages.reject.postponeVotingClosed,
      session_postpone_closed: rejectMessages.reject.postponeVotingClosed,
      member_not_registered: rejectMessages.reject.memberNotRegistered
    });
  });

  it("checks cheap-first guard failures in guild, channel, member order", () => {
    expect(cheapFirstGuard("wrong-guild", "wrong-channel", "not-member")).toBe("wrong_guild");
    expect(cheapFirstGuard(appConfig.discord.guildId, "wrong-channel", "not-member")).toBe("wrong_channel");
    expect(cheapFirstGuard(appConfig.discord.guildId, appConfig.discord.channelId, "not-member")).toBe("not_member");
    expect(cheapFirstGuard(appConfig.discord.guildId, appConfig.discord.channelId, memberUserId)).toBeUndefined();
  });

  it("builds ephemeral reject payloads", () => {
    expect(buildEphemeralReject("rejected")).toStrictEqual({
      content: "rejected",
      flags: MessageFlags.Ephemeral
    });
  });
});
