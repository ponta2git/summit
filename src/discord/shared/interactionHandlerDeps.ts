import type { Client } from "discord.js";

import type { AppContext } from "../../appContext.js";
import type { SendAskMessageResult } from "../../features/ask-session/send.js";

export type SendAsk = (args: {
  readonly trigger: "cron" | "command";
  readonly invokerId?: string;
}) => Promise<SendAskMessageResult>;

export interface AppReadyState {
  ready: boolean;
  reason: string | undefined;
}

export interface InteractionHandlerDeps {
  readonly sendAsk: SendAsk;
  readonly client: Client;
  readonly context: AppContext;
  readonly getReadyState?: () => AppReadyState;
  readonly wakeScheduler?: (reason: string) => void;
}
