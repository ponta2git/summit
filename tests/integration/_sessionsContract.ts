import {
  assertSchemaReady,
  createIntegrationDb,
  seedBaseMembers,
  truncatePerTestTables
} from "./_support.js";

export const baseSession = {
  weekKey: "2026-W17",
  postponeCount: 0,
  candidateDateIso: "2026-04-24",
  channelId: "channel-1",
  deadlineAt: new Date("2026-04-24T12:30:00.000Z")
} as const;

export const createSessionsContractHarness = () => {
  const { db, client } = createIntegrationDb();
  return {
    db,
    initialize: async (): Promise<void> => {
      await assertSchemaReady(db);
      await seedBaseMembers(db);
    },
    reset: async (): Promise<void> => {
      await truncatePerTestTables(db);
    },
    close: async (): Promise<void> => {
      await client.end({ timeout: 5 });
    }
  };
};
