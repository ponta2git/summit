import { eq, sql } from "drizzle-orm";
import { discordNotificationSettings, matchDrafts, matches, momoLoginAccounts, gameTitles, mapMasters, seasonMasters, heldEvents } from "../../src/db/schema.ts";
import { makeResultNotificationsPort } from "../../src/db/repositories/resultNotifications.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { createIntegrationDb, seedBaseMembers, truncatePerTestTables } from "./_support.ts";

export const createResultNotificationHarness = async () => {
  const { db, client } = createIntegrationDb({ maxConnections: 4 });
  await truncatePerTestTables(db);
  await seedBaseMembers(db);
  await db.update(discordNotificationSettings).set({ enabled: true, generation: 0n });
  await db.insert(momoLoginAccounts).values({ id: "result-account", discordUserId: "result-user", displayName: "Test account" }).onConflictDoNothing();
  await db.insert(gameTitles).values({ id: "title-1", name: "Title", layoutFamily: "momotetsu_2" }).onConflictDoNothing();
  await db.insert(mapMasters).values({ id: "map-1", gameTitleId: "title-1", name: "Map" }).onConflictDoNothing();
  await db.insert(seasonMasters).values({ id: "season-1", gameTitleId: "title-1", name: "Season" }).onConflictDoNothing();
  await db.insert(heldEvents).values({ id: "held-1", heldDateIso: "2026-09-08", startAt: notificationNow });
  await db.insert(matchDrafts).values({ id: "draft-1", createdByAccountId: "result-account", status: "draft_ready" });
  await db.insert(matches).values({ id: "match-1", heldEventId: "held-1", matchNoInEvent: 1, gameTitleId: "title-1", layoutFamily: "momotetsu_2",
    mapMasterId: "map-1", seasonMasterId: "season-1", ownerMemberId: "m1", playedAt: notificationNow, createdByAccountId: "result-account" });
  return { db, client, port: makeResultNotificationsPort(db),
    deleteMatch: async () => { await db.delete(matches).where(eq(matches.id, "match-1")); },
    close: () => client.end({ timeout: 5 }),
    countReceipts: async () => Number((await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM discord_notifications`))[0]?.count)
  };
};
