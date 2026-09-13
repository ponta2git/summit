import * as Effect from "effect/Effect";
import type { Client } from "discord.js";

import type { AppContext } from "../appContext.ts";
import { reconcileMissingAsk } from "./reconciler.missingAsk.ts";
import { reconcileMissingMessageIntents } from "./reconciler.missingAskMessage.ts";
import { reconcileOutboxClaims } from "./reconciler.outboxClaims.ts";
import { reconcileOutboxDeadLetters } from "./reconciler.outboxDeadLetters.ts";
import { probeDeletedMessagesAtStartup } from "./reconciler.probeDeleted.ts";
import { reconcileStrandedCancelled } from "./reconciler.strandedCancelled.ts";
import type { ReconcileReport, ReconcileScope } from "./reconciler.types.ts";
import type { SchedulerBatchReport, SchedulerEffect } from "./scheduler.types.ts";

/**
 * Run all reconciliation invariants for the given scope.
 *
 * @remarks
 * idempotent: いずれの scope も DB を正本として冪等に収束させる。
 * - `startup`: A〜C + F + invariant D (active probe)。
 * - `reconnect`: A〜C + F (D は毎再接続で fetch させないため除外)。
 *    in-flight lock / debounce は呼び出し側が保証する。
 */
export const runReconciler = (
  client: Client,
  ctx: AppContext,
  options: { readonly scope: ReconcileScope }
): SchedulerEffect<ReconcileReport> =>
  Effect.gen(function* () {
    const deadLetterRecovery = options.scope === "startup"
      ? yield* reconcileOutboxDeadLetters(ctx)
      : { deadLettersRequeued: 0, successorsRequeued: 0 };
    const cancelledReport = yield* reconcileStrandedCancelled(client, ctx);
    const askCreated = yield* reconcileMissingAsk(ctx);
    const messageReport = yield* reconcileMissingMessageIntents(ctx);
    // why: active probe は startup 限定。reconnect は毎回 Discord fetch するコストに見合わず、
    //   scheduler tick の opportunistic な updateAskMessage に委ねる。
    const probeReport: SchedulerBatchReport = options.scope === "startup"
      ? yield* probeDeletedMessagesAtStartup(client, ctx)
      : { processed: 0, succeeded: 0, failures: [] };
    const outboxClaimReleased = yield* reconcileOutboxClaims(ctx);

    return {
      cancelledPromoted: cancelledReport.succeeded,
      askCreated,
      messageIntentsQueued: messageReport.succeeded,
      outboxClaimReleased,
      outboxDeadLettersRequeued: deadLetterRecovery.deadLettersRequeued,
      outboxSuccessorsRequeued: deadLetterRecovery.successorsRequeued,
      failures: [
        ...cancelledReport.failures,
        ...messageReport.failures,
        ...probeReport.failures
      ]
    };
  });
