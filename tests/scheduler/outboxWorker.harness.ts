import { ChannelType, type Client, type MessageCreateOptions } from "discord.js";
import { vi } from "vitest";

import { asDiscordClient } from "../helpers/discord.js";

export const stubChannel = (overrides?: { readonly sendThrows?: boolean }) => {
  const sentMessages: Array<{ readonly id: string; readonly payload: MessageCreateOptions }> = [];
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: vi.fn(async (payload: MessageCreateOptions) => {
      if (overrides?.sendThrows) {
        throw new Error("Discord API failure");
      }
      const message = { id: `posted-${sentMessages.length + 1}`, payload };
      sentMessages.push(message);
      return message;
    })
  };
  return { channel, sentMessages };
};

export const stubClient = (
  channel: unknown,
  resolveChannel: () => Promise<unknown> = async () => channel
): Client => asDiscordClient({ channels: { fetch: vi.fn(resolveChannel) } });
