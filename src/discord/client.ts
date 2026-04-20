import { Client, GatewayIntentBits } from "discord.js";

import { env } from "../env.js";

// invariant: Bot は Guilds intent のみで動作する。MessageContent / GuildMembers / GuildMessages は不要で、
//   最小権限 (OAuth scope: bot + applications.commands、Permission: View Channel / Send Messages / Embed Links) を維持する。
// @see docs/adr/0005-operations-policy.md
//
// why: env.DEV_SUPPRESS_MENTIONS === true のとき `allowedMentions: { parse: [] }` を ClientOptions に渡す。
//   本文からの mention 行除去（render / postpone/render / settle）と二段構え。Client-level 設定は
//   後から message 単位で `allowedMentions` を付けない限り全 send / edit / reply / followUp に適用される。
// invariant: 本番 (DEV_SUPPRESS_MENTIONS 未設定 = false) では従来どおり allowedMentions を指定せず、
//   Discord の既定挙動（content 中の `<@id>` で push 通知）に委ねる。
// @see docs/adr/0011-dev-mention-suppression.md
export const createDiscordClient = (): Client =>
  new Client({
    intents: [GatewayIntentBits.Guilds],
    ...(env.DEV_SUPPRESS_MENTIONS ? { allowedMentions: { parse: [] } } : {})
  });
