import type { AddressInfo } from "node:net";
import type { Client } from "discord.js";
import type { AppContext } from "../appContext.ts";
import { logger } from "../logger.ts";
import { drainResources, stopResources } from "../runtime/lifecycle.ts";
import { createResultNotificationDispatcher } from "./delivery/composition.result.ts";
import { createNotificationReceiver } from "./http.ts";
import type { MaintenanceDrain } from "../startup/maintenanceDrain.ts";

interface ResultNotificationRuntime {
  start(): Promise<void>;
  address(): AddressInfo | null;
  wake(reason: string): void;
  drainOperations(): Promise<void>;
  stopBusiness(): void;
  drainBusiness(): Promise<void>;
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
  readonly maintenance?: MaintenanceDrain;
}): ResultNotificationRuntime => {
  const dispatcher = createResultNotificationDispatcher({ client: deps.client, port: deps.context.ports.resultNotifications,
    clock: deps.context.clock, context: { webOrigin: deps.webOrigin, channelId: deps.channelId } });
  const receiver = createNotificationReceiver({ port: deps.context.ports.resultNotifications, clock: deps.context.clock,
    token: deps.token, operationsToken: deps.operationsToken, canAccept: deps.canAccept,
    wake: reason => dispatcher.wake(reason), logger,
    ...(deps.maintenance ? { maintenance: deps.maintenance } : {}) });
  return {
    start: () => receiver.start(deps.host, deps.port),
    address: () => { const address = receiver.server.address(); return typeof address === "object" ? address : null; },
    wake: (reason: string) => dispatcher.wake(reason),
    drainOperations: () => receiver.drainOperations(),
    stopBusiness: () => stopResources([() => receiver.stopBusiness(), () => dispatcher.stop()]),
    drainBusiness: () => drainResources([() => receiver.drainBusiness(), () => dispatcher.drain()]),
    stop: () => stopResources([() => receiver.stop(), () => dispatcher.stop()]),
    drain: () => drainResources([() => receiver.drain(), () => dispatcher.drain()])
  };
};
