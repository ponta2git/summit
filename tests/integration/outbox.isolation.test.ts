import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { makeRealPorts } from "../../src/db/ports.real.ts";
import { claimNextOutboxBatch, enqueueOutbox, findStrandedOutboxEntries } from "../../src/db/repositories/outbox.ts";
import { buildAskBodyIntent } from "../../src/db/repositories/sessionOutboxIntents.ts";
import { discordNotifications, sessions } from "../../src/db/schema.ts";
import { reconcileMissingMessageIntents } from "../../src/scheduler/reconciler.missingAskMessage.ts";
import { runEffect } from "../helpers/assertions.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { createIntegrationDb, isIntegration, truncatePerTestTables } from "./_support.ts";

const describeDb = isIntegration ? describe : describe.skip;

describeDb("attendance outbox failure isolation (integration)", () => {
  const { db } = createIntegrationDb();
  const now = new Date("2026-04-24T12:00:00Z");
  const first = buildSessionRow({ id: "first" });
  const second = buildSessionRow({ id: "second", candidateDateIso: "2026-05-01" });
  const ports = makeRealPorts(db);

  beforeEach(async () => {
    await truncatePerTestTables(db);
    await db.insert(sessions).values([first, second]);
  });

  it("dead-letters a malformed payload while claiming unrelated work and retaining diagnostics", async () => {
    const bad = await enqueueOutbox(db, buildAskBodyIntent(first));
    const good = await enqueueOutbox(db, buildAskBodyIntent(second));
    const successor = await enqueueOutbox(db, { ...buildAskBodyIntent(first, 1), dedupeKey: "successor" });
    // Deliberately emulate a stored payload from an incompatible writer; SQL permits this JSON shape.
    await db.update(discordNotifications).set({ payload: { kind: "send_message", channelId: first.channelId } })
      .where(eq(discordNotifications.id, bad.id));
    await db.update(discordNotifications).set({ nextAttemptAt: now });

    expect((await claimNextOutboxBatch(db, { limit: 10, now, claimDurationMs: 30_000 })).map(row => row.id))
      .toStrictEqual([good.id]);
    const rows = await db.select({ id: discordNotifications.id, status: discordNotifications.status,
      attemptCount: discordNotifications.attemptCount, claimToken: discordNotifications.claimToken,
      lastError: discordNotifications.lastError }).from(discordNotifications);
    expect(rows.find(row => row.id === bad.id)).toStrictEqual({
      id: bad.id, status: "FAILED", attemptCount: 1, claimToken: null, lastError: "invalid_payload"
    });
    expect(rows.find(row => row.id === successor.id)).toMatchObject({ status: "CANCELLED", claimToken: null });
    expect((await findStrandedOutboxEntries(db, 5)).map(row => row.id)).toStrictEqual([bad.id]);
  });

  it("does not enqueue missing messages from a snapshot superseded by cancel_week", async () => {
    const staleReadPorts = { ...ports, sessions: { ...ports.sessions,
      findMessageRecoveryCandidates: async () => {
        const snapshot = await ports.sessions.findMessageRecoveryCandidates();
        await ports.sessionCommands.cancelWeekAtomically({
          sentinelSessionId: "unused", weekKey: first.weekKey, candidateDateIso: first.candidateDateIso,
          deadlineAt: first.deadlineAt, channelId: first.channelId,
          invokerUserId: "333333333333333333", suppressMentions: true, now
        });
        return snapshot.filter(row => row.id === first.id);
      }
    } };
    const report = await runEffect(reconcileMissingMessageIntents({ ports: staleReadPorts, clock: { now: () => now } }));
    expect(report).toStrictEqual({ processed: 1, succeeded: 0, failures: [] });
    expect(await db.select({ dedupeKey: discordNotifications.dedupeKey, status: discordNotifications.status })
      .from(discordNotifications)).toStrictEqual([{ dedupeKey: `cancel-week-notice-${first.weekKey}`, status: "PENDING" }]);
  });
});
