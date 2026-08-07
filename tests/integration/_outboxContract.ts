import { sql } from "drizzle-orm";

import {
  enqueueOutbox,
  type OutboxPayload
} from "../../src/db/repositories/outbox.js";
import { createAskSession } from "../../src/db/repositories/sessions.js";
import { discordOutbox } from "../../src/db/schema.js";
import {
  assertSchemaReady,
  createIntegrationDb,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

const baseSession = {
  id: "sess-outbox",
  weekKey: "2026-W17",
  postponeCount: 0,
  candidateDateIso: "2026-04-24",
  channelId: "channel-1",
  deadlineAt: new Date("2026-04-24T12:30:00.000Z")
} as const;

const basePayload: OutboxPayload = {
  kind: "send_message",
  renderer: "ask_body",
  channelId: "channel-1",
  target: "askMessageId"
};

export const createOutboxContractHarness = () => {
  const { db, client } = createIntegrationDb();
  let nextAggregateRevision = 0;

  const forceNextAttemptAt = async (dedupeKey: string, at: Date): Promise<void> => {
    await db
      .update(discordOutbox)
      .set({ nextAttemptAt: at })
      .where(sql`${discordOutbox.dedupeKey} = ${dedupeKey}`);
  };

  const enqueueWithNextAttempt = async (
    dedupeKey: string,
    nextAttemptAt: Date
  ): Promise<{ id: string }> => {
    const result = await enqueueOutbox(db, {
      kind: "send_message",
      sessionId: baseSession.id,
      payload: basePayload,
      dedupeKey,
      aggregateRevision: nextAggregateRevision++,
      ordinal: 0
    });
    await forceNextAttemptAt(dedupeKey, nextAttemptAt);
    return { id: result.id };
  };

  return {
    db,
    baseSession,
    basePayload,
    enqueueWithNextAttempt,
    initialize: async (): Promise<void> => {
      await assertSchemaReady(db);
      await seedBaseMembers(db);
    },
    reset: async (): Promise<void> => {
      nextAggregateRevision = 0;
      await truncatePerTestTables(db);
      await createAskSession(db, { ...baseSession });
    },
    close: async (): Promise<void> => {
      await client.end({ timeout: 5 });
    }
  };
};
