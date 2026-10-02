import type { RESTOptions } from "@discordjs/rest";
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import { vi } from "vitest";

const guildId = "100000000000000001";
const channelId = "100000000000000002";
const clients = new Set<Client>();

export const restResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const resultMessageRestHarness = async () => {
  let ordinal = 0n;
  const stored = new Map<string, object>();
  const reply = (content: string): Response => {
    const message = {
      id: String(100000000000001000n + ordinal++), channel_id: channelId, guild_id: guildId,
      type: 0, content, author: { id: "100000000000000003", username: "Offline Bot", discriminator: "0", bot: true },
      timestamp: "2026-01-01T00:00:00.000Z", edited_timestamp: null, tts: false, mention_everyone: false,
      mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, flags: 0, components: []
    };
    stored.set(message.id, message);
    return restResponse(message);
  };
  const post = vi.fn<(body: { content: string; nonce?: string; enforce_nonce?: boolean }) => Promise<Response>>()
    .mockImplementation(async body => reply(body.content));
  const request = vi.fn<RESTOptions["makeRequest"]>().mockImplementation(async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === "GET" && path === `/api/v10/guilds/${guildId}`) {
      return restResponse({ id: guildId, name: "Offline Guild", roles: [], emojis: [], stickers: [], features: [] });
    }
    if (init.method === "GET" && path === `/api/v10/channels/${channelId}`) {
      return restResponse({ id: channelId, guild_id: guildId, type: ChannelType.GuildText,
        name: "shared-attendance-and-results", permission_overwrites: [] });
    }
    if (init.method === "GET" && path.startsWith(`/api/v10/channels/${channelId}/messages/`)) {
      const message = stored.get(path.split("/").at(-1) ?? "");
      if (message) { return restResponse(message); }
    }
    if (init.method === "POST" && path === `/api/v10/channels/${channelId}/messages` && typeof init.body === "string") {
      return post(JSON.parse(init.body));
    }
    throw new Error("Unexpected offline Discord request");
  });
  // invariant: HTTPだけを差替え、200件cache・REST queue/retry/timeout/sweeperはSDKの既定値を使う。
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { makeRequest: request } });
  clients.add(client);
  client.rest.setToken("controlled-dummy-token");
  await client.guilds.fetch(guildId);
  const channel = await client.channels.fetch(channelId);
  if (channel?.type !== ChannelType.GuildText) { throw new Error("Expected offline text channel"); }
  return { client, channel, post, request, reply };
};

export const destroyResultMessageClients = async (): Promise<void> => {
  await Promise.all([...clients].map(client => client.destroy()));
  clients.clear();
};
