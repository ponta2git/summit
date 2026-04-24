import type { Client } from "discord.js";

import type { AppContext } from "../appContext.js";
import { reconcileMissingAsk } from "./reconciler.missingAsk.js";
import { reconcileMissingAskMessage } from "./reconciler.missingAskMessage.js";
import { reconcileOutboxClaims } from "./reconciler.outboxClaims.js";
import { probeDeletedMessagesAtStartup } from "./reconciler.probeDeleted.js";
import { reconcileStaleReminderClaims } from "./reconciler.staleReminderClaims.js";
import { reconcileStrandedCancelled } from "./reconciler.strandedCancelled.js";
import type { ReconcileReport, ReconcileScope } from "./reconciler.types.js";

const EMPTY_REPORT: ReconcileReport = {
  cancelledPromoted: 0,
  askCreated: 0,
  messageResent: 0,
  staleClaimReclaimed: 0,
  outboxClaimReleased: 0
};

/**
 * Run all reconciliation invariants for the given scope.
 *
 * @remarks
 * idempotent: いずれの scope も DB を正本として冪等に収束させる (ADR-0001)。
 * - `startup`: A〜C + E + F + invariant D (active probe)。
 * - `reconnect`: A〜C + E + F (D は毎再接続で fetch させないため除外)。
 *    in-flight lock / debounce は呼び出し側が保証する (ADR-0036)。
 * - `tick`: E のみ (毎 tick 境界で軽量に stale reminder claim を回収)。
 * @see ADR-0033
 * @see ADR-0036
 */
export const runReconciler = async (
  client: Client,
  ctx: AppContext,
  options: { readonly scope: ReconcileScope }
): Promise<ReconcileReport> => {
  if (options.scope === "tick") {
    const staleClaimReclaimed = await reconcileStaleReminderClaims(ctx);
    return { ...EMPTY_REPORT, staleClaimReclaimed };
  }

  const cancelledPromoted = await reconcileStrandedCancelled(client, ctx);
  const askCreated = await reconcileMissingAsk(client, ctx);
  const messageResent = await reconcileMissingAskMessage(client, ctx);
  // why: active probe は startup 限定。reconnect は毎回 Discord fetch するコストに見合わず、
  //   scheduler tick の opportunistic な updateAskMessage に委ねる。
  if (options.scope === "startup") {
    await probeDeletedMessagesAtStartup(client, ctx);
  }
  const staleClaimReclaimed = await reconcileStaleReminderClaims(ctx);
  const outboxClaimReleased = await reconcileOutboxClaims(ctx);

  return {
    cancelledPromoted,
    askCreated,
    messageResent,
    staleClaimReclaimed,
    outboxClaimReleased
  };
};
