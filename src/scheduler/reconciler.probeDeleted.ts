import * as Effect from "effect/Effect";
import type { Client } from "discord.js";

import type { AppContext } from "../appContext.ts";
import { fromDatabaseCall } from "../errors/effect.ts";
import { probeAskMessage } from "../features/ask-session/messageEditor.ts";
import { probePostponeMessage } from "../features/postpone-voting/messageEditor.ts";
import { logger } from "../logger.ts";
import {
  runSchedulerBatchEffect,
  type SchedulerBatchReport,
  type SchedulerEffect
} from "./scheduler.types.ts";

/**
 * Invariant D (startup active probe): Detect deleted Discord messages at boot.
 *
 * @remarks
 * `updateAskMessage` は opportunistic に 10008 を拾って再投稿するが、停止中は interaction が
 * 無いため ask / postpone メッセージが削除されたまま放置される。startup 時のみ能動的に fetch し、
 * Unknown Message (10008) 検知で新規投稿して ID を差し替える。tick scope では毎分 fetch コストに
 * 見合わないため実施しない。
 */
export const probeDeletedMessagesAtStartup = (
  client: Client,
  ctx: AppContext
): SchedulerEffect<SchedulerBatchReport> =>
  Effect.flatMap(fromDatabaseCall(
    () => ctx.ports.sessions.findMessageRecoveryCandidates(),
    "Failed to find message recovery candidates for probing."
  ), (nonTerminal) =>
    runSchedulerBatchEffect(
      "message_probe",
      nonTerminal,
      (session) => Effect.gen(function* () {
        const ask = yield* probeAskMessage(client, ctx, session);
        const postpone = session.status === "POSTPONE_VOTING" || session.status === "POSTPONED"
          ? yield* probePostponeMessage(client, ctx, session) : false;
        return (ask ? 1 : 0) + (postpone ? 1 : 0);
      }),
      (session) => ({ sessionId: session.id, weekKey: session.weekKey }),
      (failure) => {
        logger.error(
          {
            error: failure.error,
            errorCode: failure.error.code,
            event: "reconciler.message_probe_failed",
            sessionId: failure.sessionId,
            weekKey: failure.weekKey
          },
          "Reconciler: failed to probe session messages at startup."
        );
      },
      (recreated) => recreated
    ));
