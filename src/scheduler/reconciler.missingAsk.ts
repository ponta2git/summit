import * as Effect from "effect/Effect";
import type { AppContext } from "../appContext.ts";
import { fromAppCall, mapDatabaseError } from "../errors/effect.ts";
import { sendAskMessage } from "../features/ask-session/send.ts";
import { isWeeklyAskWindow } from "../time/index.ts";
import type { SchedulerEffect } from "./scheduler.types.ts";

/** Retry missing weekly creation only inside Friday's publication window. */
export const reconcileMissingAsk = (ctx: AppContext): SchedulerEffect<number> =>
  Effect.suspend(() => {
    if (!isWeeklyAskWindow(ctx.clock.now())) { return Effect.succeed(0); }
    return Effect.map(fromAppCall(
      () => sendAskMessage({ trigger: "cron", context: ctx }),
      mapDatabaseError("Failed to create missing ASK session.")
    ), result => result.status === "queued" ? 1 : 0);
  });
