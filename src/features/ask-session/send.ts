import { randomUUID } from "node:crypto";
import type { AppContext } from "../../appContext.ts";
import type { CreationRejection } from "../../domain/sessionCreation.ts";
import { ShutdownError } from "../../errors/index.ts";
import { logger } from "../../logger.ts";
import { isShuttingDown } from "../../shutdown.ts";
import { isoWeekKey } from "../../time/index.ts";
import { appConfig } from "../../userConfig.ts";

export interface SendAskMessageContext {
  readonly trigger: "cron" | "command";
  readonly invokerId?: string;
  readonly requestId?: string;
  readonly context: AppContext;
}
export type SendAskMessageResult =
  | { readonly status: "queued"; readonly weekKey: string; readonly sessionId: string }
  | { readonly status: "skipped"; readonly weekKey: string; readonly sessionId?: string;
    readonly reason: CreationRejection | "duplicate" };
// Lifetime ownership only. Admission and replay identity belong to the database.
const inFlightSends = new Set<Promise<SendAskMessageResult>>();
const createAsk = async (input: SendAskMessageContext): Promise<SendAskMessageResult> => {
  const now = input.context.clock.now();
  const result = await input.context.ports.sessionCommands.createSession({
    id: randomUUID(), source: input.trigger === "cron" ? "weekly_auto" : "manual",
    ...(input.requestId ? { requestId: input.requestId } : {}), channelId: appConfig.discord.channelId, now
  });
  const outcome: SendAskMessageResult = result.kind === "created"
    ? { status: "queued", weekKey: result.session.weekKey, sessionId: result.session.id }
    : {
      status: "skipped", weekKey: result.session?.weekKey ?? isoWeekKey(now),
      ...(result.session ? { sessionId: result.session.id } : {}),
      reason: result.kind === "rejected" ? result.reason : "duplicate"
    };
  logger.info({ ...outcome, trigger: input.trigger, userId: input.invokerId },
    "Ask admission completed.");
  return outcome;
};
export const sendAskMessage = async (input: SendAskMessageContext): Promise<SendAskMessageResult> => {
  if (isShuttingDown()) { throw new ShutdownError("Shutdown in progress."); }
  const pending = createAsk(input);
  inFlightSends.add(pending);
  try { return await pending; }
  finally { inFlightSends.delete(pending); }
};
export const waitForInFlightSend = async (): Promise<void> => {
  await Promise.allSettled([...inFlightSends]);
};
