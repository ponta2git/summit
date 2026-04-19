import cron, { type ScheduledTask } from "node-cron";
import type { Client } from "discord.js";

import { logger } from "../logger.js";
import { sendAskMessage, type SendAskMessageContext, type SendAskMessageResult } from "../discord/askMessage.js";
import { systemClock, type Clock } from "../time/index.js";

type SendAsk = (context: SendAskMessageContext) => Promise<SendAskMessageResult>;

interface CronAdapter {
  schedule(
    expression: string,
    handler: () => void | Promise<void>,
    options: { timezone: string; noOverlap: boolean }
  ): ScheduledTask;
}

export interface AskSchedulerDeps {
  client: Client;
  sendAsk?: SendAsk;
  clock?: Clock;
  cronAdapter?: CronAdapter;
}

export const runScheduledAskTick = async (sendAsk: SendAsk, clock: Clock): Promise<void> => {
  try {
    await sendAsk({
      trigger: "cron",
      clock
    });
  } catch (error: unknown) {
    logger.error({ error }, "Scheduled /ask delivery failed.");
  }
};

export const createAskScheduler = (deps: AskSchedulerDeps): ScheduledTask => {
  const clock = deps.clock ?? systemClock;
  const sendAsk = deps.sendAsk ?? ((context: SendAskMessageContext) => sendAskMessage(deps.client, context));
  const cronModule = deps.cronAdapter ?? cron;

  return cronModule.schedule(
    "0 8 * * 5",
    () => void runScheduledAskTick(sendAsk, clock),
    {
      timezone: "Asia/Tokyo",
      noOverlap: true
    }
  );
};
