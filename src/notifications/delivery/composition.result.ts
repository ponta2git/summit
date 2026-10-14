import type { Client } from "discord.js";
import type { Logger } from "pino";
import type * as Effect from "effect/Effect";
import type { ClaimedResultNotification, ResultDeliveryContext, ResultNotificationsPort } from "../../db/ports.resultNotifications.ts";
import { logger as defaultLogger } from "../../logger.ts";
import type { Clock } from "../../time/index.ts";
import type { DeliveryTask } from "./contracts.ts";
import { prepareResultDelivery } from "./definitions/result.ts";
import { deliverPreparedResultNotification } from "./resultDelivery.ts";
import { createResultDeliveryRuntime } from "./resultRuntime.ts";
import type { DeliveryRuntime } from "./runtime.ts";
import { createResultDeliverySource } from "./sources/result.ts";
import { deliverResumable, type ResumableStrategy } from "./strategies/resumable.ts";

interface ResultComposition {
  readonly client: Client;
  readonly port: ResultNotificationsPort;
  readonly clock: Clock;
  readonly context: ResultDeliveryContext;
  readonly logger?: Pick<Logger, "info" | "warn" | "error">;
  readonly prepareNotification?: typeof prepareResultDelivery;
  readonly strategy?: ResumableStrategy;
}

/** Synchronous preparation leaves only a retained plan and metadata in each asynchronous task. */
const createResultTaskFactory = (deps: ResultComposition): ((
  entry: ClaimedResultNotification, consumeYieldRequest: () => boolean
) => DeliveryTask<Effect.Error<ReturnType<typeof deliverPreparedResultNotification>>>) => {
  const logger = deps.logger ?? defaultLogger;
  const prepare = deps.prepareNotification ?? prepareResultDelivery;
  const strategy = deps.strategy ?? deliverResumable;
  return (entry, consumeYieldRequest) => {
    const { id, payloadBytes } = entry;
    const prepared = prepare(entry, deps.context);
    return { id, payloadBytes, run: execution => deliverPreparedResultNotification({
      client: deps.client, port: deps.port, clock: deps.clock, logger, strategy,
      isStopping: execution.isStopping, consumeYieldRequest
    }, prepared) };
  };
};

/** Bind the result selection policy and replaceable delivery implementation at one composition root. */
export const createResultNotificationDispatcher = (deps: ResultComposition): DeliveryRuntime => createResultDeliveryRuntime({
  source: createResultDeliverySource(deps.port, deps.clock), clock: deps.clock,
  prepareTask: createResultTaskFactory(deps), logger: deps.logger ?? defaultLogger
});
