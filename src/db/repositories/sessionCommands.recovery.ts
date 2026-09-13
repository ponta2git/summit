import type { DbLike } from "../rows.ts";
import { enqueueOutboxInTransaction, type EnqueueOutboxInput } from "./outbox.ts";
import { lockSession } from "./sessionCommands.shared.ts";
import { buildMissingMessageIntents } from "./sessionOutboxIntents.ts";

/** 取消と同じSession lockの下で、欠落messageの現在状態を検証する。 */
export const recoverMissingMessageIntents = (
  db: DbLike,
  sessionId: string
): Promise<readonly EnqueueOutboxInput[]> => db.transaction(async tx => {
  const current = await lockSession(tx, sessionId);
  if (!current) { return []; }

  const queued: EnqueueOutboxInput[] = [];
  for (const intent of buildMissingMessageIntents(current)) {
    const result = await enqueueOutboxInTransaction(tx, intent);
    if (!result.skipped) { queued.push(intent); }
  }
  return queued;
});
