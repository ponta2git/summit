import { eq, sql } from "drizzle-orm";
import type { DiscordResultNotification } from "@momo/db/notifications";
import { discordNotificationSettings, matchDrafts, matches, momoLoginAccounts, gameTitles, mapMasters, seasonMasters, heldEvents } from "../../src/db/schema.ts";
import { makeResultNotificationsPort } from "../../src/db/repositories/resultNotifications.ts";
import { notificationNow } from "../contracts/resultNotifications.ts";
import { createIntegrationDb, seedBaseMembers, truncatePerTestTables } from "./_support.ts";
import { assertNewNotificationPartLimit } from "../../src/features/result-notifications/render.ts";
import { normalizeNotificationJson } from "../../src/db/repositories/notifications.hash.ts";

export const checkNotificationAdmission = (payload: DiscordResultNotification): void =>
  assertNewNotificationPartLimit(payload, "https://example.test");

let pool: ReturnType<typeof createIntegrationDb> | undefined;
export const createResultNotificationHarness = async () => {
  const { db, client } = pool ??= createIntegrationDb({ maxConnections: 4 });
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
  return { db, client, port: makeResultNotificationsPort(db, checkNotificationAdmission),
    // Seed an already accepted snapshot without applying today's admission policy.
    seedStoredNotification: async (payload: DiscordResultNotification): Promise<void> => {
      const normalized = await normalizeNotificationJson(db, JSON.stringify(payload));
      await client.begin(async tx => {
        await tx`INSERT INTO discord_notifications (id, family, kind, dedupe_key, schema_version, payload, payload_hash,
          created_at, updated_at, next_attempt_at)
          VALUES (${payload.notificationId}, 'result', ${payload.kind}, ${payload.notificationId}, ${payload.schemaVersion},
            ${normalized.text}::jsonb, ${normalized.hash}, ${notificationNow.toISOString()}, ${notificationNow.toISOString()}, ${notificationNow.toISOString()})`;
        await tx`INSERT INTO discord_notification_results (notification_id, kind, source_job_id, occurred_at, settings_generation)
          VALUES (${payload.notificationId}, ${payload.kind}, ${payload.sourceJobId}, ${payload.occurredAt}, ${payload.settingsGeneration})`;
        const targetKind = payload.kind === "ocr_completed" ? "match_draft" : "match";
        const ids = payload.kind === "ocr_completed" ? [payload.data.matchDraftId] : payload.data.matches.map(match => match.matchId);
        for (const id of ids) {
          await tx`INSERT INTO discord_notification_targets (notification_id, target_kind, target_id)
            VALUES (${payload.notificationId}, ${targetKind}, ${id})`;
        }
      });
    },
    deleteMatch: async () => { await db.delete(matches).where(eq(matches.id, "match-1")); },
    countReceipts: async () => Number((await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM discord_notifications`))[0]?.count)
  };
};
