import {
  ChannelType,
  type Client,
  type Message,
  type MessagePayload,
  type TextChannel
} from "discord.js";
import { vi } from "vitest";
import { callArg } from "./assertions.js";

type SendResult = { readonly id: string };
type SendImpl = (payload: unknown) => Promise<SendResult>;
type EditImpl = (payload: unknown) => Promise<unknown>;

export const asDiscordClient = (client: unknown): Client =>
  client as unknown as Client;

export const asDiscordMessage = (message: unknown): Message =>
  message as unknown as Message;

export const asTextChannel = (channel: unknown): TextChannel =>
  channel as unknown as TextChannel;

export const createEditableMessage = (
  id: string,
  editImpl: EditImpl = async () => undefined
): Message => {
  const edit = vi.fn(editImpl);
  return asDiscordMessage({ id, edit });
};

export const createSendableTextChannel = (
  sendImpl: SendImpl = async () => ({ id: "discord-message-1" }),
  options: {
    readonly fetchedMessage?: Message;
  } = {}
) => {
  const send = vi.fn(sendImpl);
  const fetch = vi.fn(async () => options.fetchedMessage ?? createEditableMessage("fetched-message-1"));
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send,
    messages: { fetch }
  };
  return { channel, send, fetch };
};

export const createClientWithChannel = (channel: unknown): Client =>
  asDiscordClient({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  });

export const createDiscordTextFixture = (
  sendImpl?: SendImpl,
  options: {
    readonly fetchedMessage?: Message;
  } = {}
) => {
  const { channel, send, fetch } = createSendableTextChannel(sendImpl, options);
  const client = createClientWithChannel(channel);
  return { client, channel, send, fetch };
};

export const sentPayload = <T = string>(send: {
  readonly mock: { readonly calls: ReadonlyArray<readonly [unknown, ...unknown[]]> };
}): T => callArg<T>(send);

export type SendPayload = string | MessagePayload;
