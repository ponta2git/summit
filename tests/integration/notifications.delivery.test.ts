import { and, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/db/schema.ts";
import { discordNotifications as notifications, discordNotificationParts as parts, matchDrafts } from "../../src/db/schema.ts";
import { completeNotificationPart } from "../../src/db/repositories/notifications.delivery.ts";
import { lockNotificationFamily, notificationTransaction } from "../../src/db/repositories/notifications.storage.ts";
import { makeResultNotificationsPort } from "../../src/db/repositories/resultNotifications.ts";
import { notificationNow as now, ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { deferred } from "../helpers/deferred.ts";
import { checkNotificationAdmission, createResultNotificationHarness } from "./_resultNotifications.ts";
import { waitForBlockedBy } from "./locking.ts";
import { isIntegration } from "./_support.ts";

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Actual Rows": number;
  readonly "Actual Loops": number;
  readonly "Rows Removed by Filter"?: number;
  readonly Plans?: readonly PlanNode[];
}
const flatten = (node: PlanNode): readonly PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
const at = (milliseconds: number): Date => new Date(now.getTime() + milliseconds);

(isIntegration ? describe : describe.skip)("notification delivery SQL boundaries", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); });

  const prepare = async (count: number) => {
    await h.port.receive(JSON.stringify(ocrReceiptPayload()), now);
    const [entry] = await h.port.claim({ limit: 1, now, claimDurationMs: 30_000 });
    if (!entry) { throw new Error("Expected result notification claim"); }
    await h.port.plan(entry.id, entry.claimToken, {
      count, rendererVersion: 1, context: { channelId: "channel", webOrigin: "https://example.test" }, now
    });
    return entry;
  };

  it("starts only the next pending part and increments its attempts once under competing begins", async () => {
    const { id, claimToken } = await prepare(2);
    expect(await h.port.begin(id, -1, claimToken, now)).toBe(false);
    expect(await h.port.begin(id, 2, claimToken, now)).toBe(false);
    expect(await h.port.begin(id, 1, claimToken, now)).toBe(false);
    expect((await Promise.all([h.port.begin(id, 0, claimToken, at(1)), h.port.begin(id, 0, claimToken, at(1))])).sort())
      .toEqual([false, true]);
    expect(await h.port.begin(id, 1, claimToken, at(2))).toBe(false);
    expect(await h.db.select({ partNo: parts.partNo, status: parts.status, attemptCount: parts.attemptCount,
      sendStartedAt: parts.sendStartedAt }).from(parts).where(eq(parts.notificationId, id)).orderBy(parts.partNo))
      .toEqual([
        { partNo: 0, status: "IN_FLIGHT", attemptCount: 1, sendStartedAt: at(1) },
        { partNo: 1, status: "PENDING", attemptCount: 0, sendStartedAt: null }
      ]);
    expect(await h.port.complete(id, 0, claimToken, "message-0", at(3))).toBe(true);
    expect(await h.port.begin(id, 1, claimToken, at(4))).toBe(true);
    await h.port.fail(id, claimToken, "delivery_uncertain", at(5), at(5));
    expect(await h.port.begin(id, 1, claimToken, at(6))).toBe(false);
    const [retry] = await h.port.claim({ limit: 1, now: at(6), claimDurationMs: 30_000 });
    if (!retry) { throw new Error("Expected retried claim"); }
    expect(await h.port.begin(id, 1, retry.claimToken, at(7))).toBe(true);
    expect(await h.port.inspect(id)).toMatchObject({ parts: [
      { partNo: 0, status: "DELIVERED", attemptCount: 1, deliveredMessageId: "message-0" },
      { partNo: 1, status: "IN_FLIGHT", attemptCount: 2 }
    ] });
  });

  it("preserves partial parent state and observes the last part update before completing the parent", async () => {
    const { id, claimToken } = await prepare(2);
    await h.db.update(notifications).set({ lastError: "delivery_uncertain" }).where(eq(notifications.id, id));
    const state = async () => (await h.db.select({ status: notifications.status, claimToken: notifications.claimToken,
      claimExpiresAt: notifications.claimExpiresAt, deliveredAt: notifications.deliveredAt,
      terminalAt: notifications.terminalAt, lastError: notifications.lastError, updatedAt: notifications.updatedAt
    }).from(notifications).where(eq(notifications.id, id)))[0];
    await h.port.begin(id, 0, claimToken, now);
    expect(await h.port.complete(id, 0, claimToken, "message-0", at(1))).toBe(true);
    expect(await state()).toEqual({ status: "IN_FLIGHT", claimToken, claimExpiresAt: at(30_000),
      deliveredAt: null, terminalAt: null, lastError: "delivery_uncertain", updatedAt: at(1) });
    await h.port.begin(id, 1, claimToken, at(2));
    expect(await h.port.complete(id, 1, claimToken, "message-1", at(3))).toBe(true);
    expect(await state()).toEqual({ status: "DELIVERED", claimToken: null, claimExpiresAt: null,
      deliveredAt: at(3), terminalAt: at(3), lastError: null, updatedAt: at(3) });
    expect(await h.port.complete(id, 1, claimToken, "duplicate", at(4))).toBe(false);
    expect(await h.port.inspect(id)).toMatchObject({ parts: [
      { partNo: 0, deliveredMessageId: "message-0" }, { partNo: 1, deliveredMessageId: "message-1" }
    ] });
  });

  it("rechecks source cancellation after waiting for the family gate", async () => {
    const { id, claimToken } = await prepare(2);
    const locked = deferred<number>(); const release = deferred<void>();
    const source = h.db.transaction(async tx => {
      await tx.update(matchDrafts).set({ status: "cancelled" }).where(eq(matchDrafts.id, "draft-1"));
      await lockNotificationFamily(tx, "result");
      const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (!backend) { throw new Error("Expected source transaction backend"); }
      locked.resolve(backend.pid); await release.promise;
    });
    const pid = await locked.promise;
    const begin = h.port.begin(id, 0, claimToken, at(1));
    try { await waitForBlockedBy(h.client, pid); }
    finally { release.resolve(); await source; }
    expect(await begin).toBe(false);
    expect(await h.port.inspect(id)).toMatchObject({ status: "CANCELLED", cancelReason: "draft_unavailable", parts: [
      { partNo: 0, status: "CANCELLED", attemptCount: 0 }, { partNo: 1, status: "CANCELLED", attemptCount: 0 }
    ] });
  });

  it("delivers one part within thirteen application statements without rereading its payload", async () => {
    const { id, claimToken } = await prepare(1);
    const queries: string[] = [];
    const measured = makeResultNotificationsPort(drizzle(h.client, { schema, casing: "snake_case",
      logger: { logQuery: query => { queries.push(query); } }
    }), checkNotificationAdmission);
    expect(await measured.begin(id, 0, claimToken, now)).toBe(true);
    expect(await measured.complete(id, 0, claimToken, "message", at(1))).toBe(true);
    // why: postgres.js の BEGIN / COMMIT 各2回は別に発行され、合計17 SQL・2 transactionsとなる。
    expect(queries).toHaveLength(13);
    expect(queries.filter(query => query.startsWith("set transaction"))).toHaveLength(2);
    expect(queries.every(query => !query.includes('"payload"'))).toBe(true);
    expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED", parts: [{ deliveredMessageId: "message" }] });
  });

  it.each([112, 8_823])("checks unfinished parts once when completing a %i-part plan", async count => {
    const { id, claimToken } = await prepare(count);
    // regression: 巨大な履歴を再配送せず、最終partを開始済みにして完了queryの走査だけを観測する。
    await h.db.update(parts).set({ status: "DELIVERED", attemptCount: 1, sendStartedAt: now,
      deliveredAt: now, deliveredMessageId: "earlier" }).where(eq(parts.notificationId, id));
    await h.db.update(parts).set({ status: "IN_FLIGHT", claimToken, deliveredAt: null, deliveredMessageId: null })
      .where(and(eq(parts.notificationId, id), eq(parts.partNo, count - 1)));
    await h.db.execute(sql`ANALYZE ${parts}`);
    let completion: SQL | undefined;
    expect(await notificationTransaction(h.db, "result", async tx => {
      const execute = vi.spyOn(tx, "execute");
      try {
        const result = await completeNotificationPart(tx, id, count - 1, claimToken, "last-message", at(1), "result");
        const query = execute.mock.calls[0]?.[0];
        if (query && typeof query !== "string") { completion = query.getSQL(); }
        return result;
      } finally { execute.mockRestore(); }
    })).toBe(true);
    if (!completion) { throw new Error("Expected parameterized completion query"); }
    const [row] = await h.db.execute<{ "QUERY PLAN": readonly { Plan: PlanNode }[] }>(
      sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${completion}`
    );
    const plan = row?.["QUERY PLAN"][0]?.Plan;
    if (!plan) { throw new Error("Expected completion execution plan"); }
    const scans = flatten(plan).filter(node => node["Relation Name"] === "discord_notification_parts");
    expect(scans).toHaveLength(1);
    expect(scans[0]?.["Actual Loops"]).toBe(1);
    expect(scans.reduce((total, scan) => total + (scan["Actual Rows"] + (scan["Rows Removed by Filter"] ?? 0)) * scan["Actual Loops"], 0))
      .toBeLessThanOrEqual(count);
    expect(await h.port.inspect(id)).toMatchObject({ status: "DELIVERED", claimExpiresAt: null });
  });
});
