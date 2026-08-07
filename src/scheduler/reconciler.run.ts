import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import { reconcileMissingAsk } from "./reconciler.missingAsk.js";
import { reconcileMissingMessageIntents } from "./reconciler.missingAskMessage.js";
import { reconcileOutboxClaims } from "./reconciler.outboxClaims.js";
import { reconcileOutboxDeadLetters } from "./reconciler.outboxDeadLetters.js";
import { probeDeletedMessagesAtStartup } from "./reconciler.probeDeleted.js";
import { reconcileStrandedCancelled } from "./reconciler.strandedCancelled.js";
import type { ReconcileReport, ReconcileScope } from "./reconciler.types.js";

/**
 * Run all reconciliation invariants for the given scope.
 *
 * @remarks
 * idempotent: いずれの scope も DB を正本として冪等に収束させる (ADR-0001)。
 * - `startup`: A〜C + F + invariant D (active probe)。
 * - `reconnect`: A〜C + F (D は毎再接続で fetch させないため除外)。
 *    in-flight lock / debounce は呼び出し側が保証する (ADR-0036)。
 * @see ADR-0051
 * @see ADR-0036
 */
export const runReconciler = async (
  client: Client,
  ctx: AppContext,
  options: { readonly scope: ReconcileScope }
): Promise<ReconcileReport> => {
  const deadLetterRecovery =
    options.scope === "startup"
      ? await reconcileOutboxDeadLetters(ctx)
      : { deadLettersRequeued: 0, successorsRequeued: 0 };
  const cancelledPromoted = await reconcileStrandedCancelled(client, ctx);
  const askCreated = await reconcileMissingAsk(ctx);
  const messageIntentsQueued = await reconcileMissingMessageIntents(ctx);
  // why: active probe は startup 限定。reconnect は毎回 Discord fetch するコストに見合わず、
  //   scheduler tick の opportunistic な updateAskMessage に委ねる。
  if (options.scope === "startup") {
    await probeDeletedMessagesAtStartup(client, ctx);
  }
  const outboxClaimReleased = await reconcileOutboxClaims(ctx);

  return {
    cancelledPromoted,
    askCreated,
    messageIntentsQueued,
    outboxClaimReleased,
    outboxDeadLettersRequeued: deadLetterRecovery.deadLettersRequeued,
    outboxSuccessorsRequeued: deadLetterRecovery.successorsRequeued
  };
};
