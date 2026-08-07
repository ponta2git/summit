import type { Client, Message, MessagePayload } from "discord.js";
import { vi } from "vitest";

import { resetSendStateForTest } from "../../src/features/ask-session/send.js";
import {
  asDiscordClient,
  asDiscordMessage,
  asTextChannel
} from "../helpers/discord.js";

interface SentMessage {
  readonly channelId: string;
  readonly payload: unknown;
}

const state = vi.hoisted(() => ({
  sentMessages: [] as SentMessage[],
  fetchedMessageIds: [] as string[],
  editCalls: [] as Array<{ messageId: string; payload: unknown }>,
  nextSentMessageId: 1,
  fetchImpl: async (messageId: string): Promise<Message> => {
    throw Object.assign(new Error(`no fetch stub for ${messageId}`), { code: 500 });
  },
  sendImpl: async (_payload: unknown): Promise<Message> => {
    throw new Error("send stub was not reset");
  }
}));

// why: reconciler は Discord side-effect を伴うため getTextChannel を fake 実装で差し替える。
// AppContext / ports 側は createTestAppContext の fake を使い、repository modules は mock しない。
vi.mock("../../src/discord/shared/channels.js", () => ({
  getTextChannel: vi.fn(async (_client: Client, channelId: string) => {
    const channel = {
      id: channelId,
      send: vi.fn(async (payload: string | MessagePayload) => state.sendImpl(payload)),
      messages: {
        fetch: vi.fn(async (id: string) => {
          state.fetchedMessageIds.push(id);
          return state.fetchImpl(id);
        })
      }
    };
    return asTextChannel(channel);
  })
}));

export const sentMessages = state.sentMessages;
export const fetchedMessageIds = state.fetchedMessageIds;
export const editCalls = state.editCalls;

export const client = asDiscordClient({});

export const resetReconcilerHarness = (): void => {
  sentMessages.length = 0;
  fetchedMessageIds.length = 0;
  editCalls.length = 0;
  state.nextSentMessageId = 1;
  state.fetchImpl = async (messageId) => {
    throw Object.assign(new Error(`no fetch stub for ${messageId}`), { code: 500 });
  };
  state.sendImpl = async (payload) => {
    const id = `sent-${String(state.nextSentMessageId++)}`;
    sentMessages.push({ channelId: "fake-channel", payload });
    return asDiscordMessage({ id });
  };
  resetSendStateForTest();
};

export const setFetchImpl = (
  impl: (messageId: string) => Promise<Message>
): void => {
  state.fetchImpl = impl;
};

export const makeMessage = (id: string): Message => {
  const edit = vi.fn(async (payload: unknown) => {
    editCalls.push({ messageId: id, payload });
    return asDiscordMessage({});
  });
  return asDiscordMessage({ id, edit });
};

export const makeSendableClient = (): Client => {
  // why: sendAskMessage は getTextChannel を経由せず client.channels.fetch を直接呼ぶ。
  const channel = {
    type: 0,
    isSendable: () => true,
    send: async (payload: unknown) => {
      const id = `sent-${String(state.nextSentMessageId++)}`;
      sentMessages.push({ channelId: "fake-channel", payload });
      return asDiscordMessage({ id });
    }
  };
  return asDiscordClient({ channels: { fetch: async () => channel } });
};

export const extractContent = (payload: unknown): string | undefined => {
  if (payload && typeof payload === "object" && "content" in payload) {
    const content = (payload as { content?: unknown }).content;
    return typeof content === "string" ? content : undefined;
  }
  return undefined;
};
