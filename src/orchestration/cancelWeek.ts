import type { Client } from "discord.js";
import * as Effect from "effect/Effect";
import type { AppContext } from "../appContext.ts";
import type { CancelWeekResult } from "../db/ports.ts";
import type { AppError } from "../errors/index.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
import { isoWeekKey } from "../time/index.ts";
import { appConfig } from "../userConfig.ts";

/** Pin the confirmation to its week, and leave all existing attendance work intact. */
export const applyManualSkip = Effect.fnUntraced(function* (
  _client: Client,
  ctx: AppContext,
  params: { readonly invokerUserId: string; readonly expectedWeekKey: string }
): Effect.fn.Return<CancelWeekResult | { readonly kind: "expired" }, AppError> {
  const now = ctx.clock.now();
  const weekKey = isoWeekKey(now);
  if (weekKey !== params.expectedWeekKey) { return { kind: "expired" as const }; }
  return yield* fromDatabaseCall(() => ctx.ports.sessionCommands.cancelWeekAtomically({
    weekKey, channelId: appConfig.discord.channelId, invokerUserId: params.invokerUserId,
    suppressMentions: appConfig.dev.suppressMentions, now
  }), "Failed to disable this week's automatic ask.");
});
