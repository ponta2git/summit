import { ChannelType, type Client, type MessageCreateOptions } from "discord.js";
import type { DbLike } from "../../src/db/rows.ts";
import { makeRealPorts } from "../../src/db/ports.real.ts";
import { createResultNotificationRuntime } from "../../src/notifications/runtime.ts";
import { systemClock } from "../../src/time/index.ts";
import { assertNewNotificationPartLimit } from "../../src/features/result-notifications/render.ts";

export interface RecordedNotification {
  readonly messageId: string;
  readonly channelId: string;
  readonly body: MessageCreateOptions;
}

/** Exercise the real receiver and dispatcher, replacing only the Discord transport. */
export const createResultNotificationRecorder = (options: {
  readonly db: DbLike;
  readonly token: string;
  readonly operationsToken: string;
  readonly webOrigin: string;
  readonly record: (message: RecordedNotification) => Promise<void>;
  readonly port?: number;
}): ReturnType<typeof createResultNotificationRuntime> => {
  let ordinal = 0;
  // why: Discord SDK の network boundary だけを置換する。DB と dispatcher は実装を使う。
  const boundary: unknown = { channels: { fetch: async (channelId: string) => ({
    type: ChannelType.GuildText, isSendable: () => true,
    send: async (body: MessageCreateOptions) => {
      const messageId = `recorded-${++ordinal}`;
      await options.record({ messageId, channelId, body });
      return { id: messageId };
    }
  }) } };
  return createResultNotificationRuntime({
    client: boundary as Client, context: { ports: makeRealPorts(options.db,
      payload => assertNewNotificationPartLimit(payload, options.webOrigin)), clock: systemClock },
    host: "127.0.0.1", port: options.port ?? 0, token: options.token, operationsToken: options.operationsToken,
    webOrigin: options.webOrigin, channelId: "recorded-channel", canAccept: () => true
  });
};
