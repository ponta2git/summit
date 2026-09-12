import type { Client } from "discord.js";
import type { AppContext } from "../appContext.ts";
import { logger } from "../logger.ts";
import { createResultNotificationDispatcher } from "../scheduler/resultNotifications.ts";
import { createNotificationReceiver } from "./http.ts";

interface ResultNotificationRuntime {
  start(): Promise<void>;
  wake(reason: string): void;
  stop(): void;
  drain(): Promise<void>;
}

export const createResultNotificationRuntime = (deps: {
  readonly client: Client;
  readonly context: AppContext;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly operationsToken: string;
  readonly webOrigin: string;
  readonly channelId: string;
  readonly canAccept: () => boolean;
}): ResultNotificationRuntime => {
  const dispatcher = createResultNotificationDispatcher({ client: deps.client, port: deps.context.ports.resultNotifications,
    clock: deps.context.clock, context: { webOrigin: deps.webOrigin, channelId: deps.channelId } });
  const receiver = createNotificationReceiver({ port: deps.context.ports.resultNotifications, clock: deps.context.clock,
    token: deps.token, operationsToken: deps.operationsToken, canAccept: deps.canAccept,
    wake: reason => dispatcher.wake(reason), logger });
  return {
    start: () => receiver.start(deps.host, deps.port),
    wake: (reason: string) => dispatcher.wake(reason),
    stop: () => { receiver.stop(); dispatcher.stop(); },
    drain: async () => { await Promise.all([receiver.drain(), dispatcher.drain()]); }
  };
};
