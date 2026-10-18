import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createMaintenanceDatabase } from "../../src/startup/maintenanceDatabase.ts";
import { sessions } from "../../src/db/schema.ts";
import { notificationNow, ocrReceiptPayload } from "../contracts/resultNotifications.ts";
import { analysisNotification } from "../features/result-notifications/fixtures.ts";
import { buildSessionRow } from "../testing/sessionScenario.ts";
import { createResultNotificationHarness } from "./_resultNotifications.ts";
import { requireLocalTestUrl } from "./databaseLifecycle.ts";

const operationsToken = "frozen-integration-operations-".repeat(2);
const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

const disposableDatabaseUrl = (): string => {
  const url = requireLocalTestUrl(process.env["DATABASE_URL"]);
  if (process.env["INTEGRATION_DB"] !== "1" || !/^\/summit_test_[a-f0-9]{32}_[a-f0-9]{12}$/.test(url.pathname)) {
    throw new Error("Frozen process tests require a file-owned integration database");
  }
  return url.href;
};

/** Exercise the real entry in a new process with a closed environment on every restart. */
const startFrozenProcess = async (): Promise<{ readonly origin: string; stop(): Promise<void> }> => {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const address = reservation.address();
  if (!address || typeof address === "string") { throw new Error("Expected loopback listener"); }
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => { if (error) { reject(error); } else { resolve(); } }));
  const child = spawn(process.execPath, [entry], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    env: { NODE_ENV: "test", TZ: "Asia/Tokyo", DISCORD_TOKEN: "controlled-frozen-test-token",
      DATABASE_URL: disposableDatabaseUrl(), SUMMIT_CONFIG_YAML: "not-business-config: true",
      MOMO_MAINTENANCE_MODE: "frozen", RESULT_NOTIFICATION_OPERATIONS_TOKEN: operationsToken,
      RESULT_NOTIFICATION_BIND_HOST: "127.0.0.1", RESULT_NOTIFICATION_PORT: String(port) }
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const deadline = setTimeout(() => reject(new Error("Frozen process did not start its listener")), 10_000);
      const settled = (error?: Error): void => { clearTimeout(deadline); if (error) { reject(error); } else { resolve(); } };
      child.once("error", () => settled(new Error("Frozen process could not be launched")));
      void exited.then(() => settled(new Error("Frozen process exited before readiness")));
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes('"event":"maintenance.frozen"')) { settled(); }
        else if (output.length > 16_384) { settled(new Error("Unexpected frozen startup output")); }
      });
    });
  } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
  return { origin: `http://127.0.0.1:${port}`, stop: async () => {
    child.kill("SIGTERM");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([exited, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Frozen shutdown did not finish")); }, 10_000);
      })]);
      if (code !== 0) { throw new Error("Frozen process did not exit cleanly"); }
    } finally { clearTimeout(deadline); await exited; }
  } };
};

describe("frozen maintenance against real PostgreSQL", () => {
  let h: Awaited<ReturnType<typeof createResultNotificationHarness>>;
  beforeEach(async () => { h = await createResultNotificationHarness(); });
  const snapshot = async (): Promise<unknown[]> => Promise.all([
    "members", "sessions", "responses", "held_events", "held_event_participants", "matches", "match_drafts",
    "discord_notifications", "discord_notification_attendance", "discord_notification_results",
    "discord_notification_settings", "discord_notification_targets", "discord_notification_parts"
  ].map(async table => {
    const [row] = await h.client<{ value: unknown }[]>`
      SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS value FROM ${h.client(table)} AS t`;
    return row?.value;
  }));

  it("preserves members, sessions, settings, pending work and claimed delivery plans across real frozen restarts", async () => {
    await h.db.insert(sessions).values(buildSessionRow());
    const payload = ocrReceiptPayload();
    await h.port.receive(JSON.stringify(payload), notificationNow);
    const [claim] = await h.port.claim({ limit: 1, now: notificationNow, claimDurationMs: 1_000 });
    if (!claim) { throw new Error("Expected claimed fixture notification"); }
    await h.port.plan(claim.id, claim.claimToken, { count: 2, rendererVersion: 2,
      context: { channelId: "channel-1", webOrigin: "https://example.test" }, now: notificationNow });
    await h.port.receive(JSON.stringify(analysisNotification()), notificationNow);
    await h.client`UPDATE discord_notification_settings SET enabled = false, generation = 9 WHERE kind = 'analysis_completed'`;
    const before = await snapshot();
    const readinessReports: unknown[] = [];
    for (let restart = 0; restart < 2; restart += 1) {
      const process = await startFrozenProcess();
      try {
        const response = await fetch(`${process.origin}/internal/maintenance/readiness`, {
          headers: { authorization: `Bearer ${operationsToken}` }
        });
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        expect(body).toStrictEqual({ service: "summit", mode: "frozen", contract: "summit-read-schema-v1", ready: true,
          database: { formatVersion: 1, targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            ledgerFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        readinessReports.push(body);
        const refused = await fetch(`${process.origin}/internal/discord-notifications`, {
          method: "POST", headers: { authorization: `Bearer ${operationsToken}`, "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        expect(refused.status).toBe(503); expect(await refused.json()).toStrictEqual({ error: "maintenance_frozen" });
      } finally { await process.stop(); }
      expect(await snapshot()).toStrictEqual(before);
    }
    expect(readinessReports[0]).toStrictEqual(readinessReports[1]);
  }, 60_000); // Two real process starts and bounded shutdowns have their own deadlines.

  it("rejects a missing packaged column and recovers without leaving a failed transaction", async () => {
    const database = createMaintenanceDatabase(disposableDatabaseUrl());
    try {
      const expected = await database.probe();
      await h.client`ALTER TABLE members RENAME COLUMN display_name TO unavailable_display_name`;
      try { await expect(database.probe()).rejects.toMatchObject({ cause: { code: "42703" } }); }
      finally { await h.client`ALTER TABLE members RENAME COLUMN unavailable_display_name TO display_name`; }
      expect(await database.probe()).toStrictEqual(expected);
    } finally { await database.close(); }
  });

  it("detects a changed complete ledger and rejects invalid history without changing business rows", async () => {
    const database = createMaintenanceDatabase(disposableDatabaseUrl());
    const before = await snapshot();
    const [lastMigration] = await h.client<{ id: number; hash: string }[]>`SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`;
    if (!lastMigration) { throw new Error("Expected applied migration history"); }
    try {
      const proof = await database.probe();
      await h.client`UPDATE drizzle.__drizzle_migrations SET hash = ${"f".repeat(64)} WHERE id = ${lastMigration.id}`;
      expect((await database.probe()).ledgerFingerprint).not.toBe(proof.ledgerFingerprint);
      await h.client`UPDATE drizzle.__drizzle_migrations SET hash = 'invalid' WHERE id = ${lastMigration.id}`;
      await expect(database.probe()).rejects.toThrow("proof is unavailable");
      expect(await snapshot()).toStrictEqual(before);
    } finally {
      await h.client`UPDATE drizzle.__drizzle_migrations SET hash = ${lastMigration.hash} WHERE id = ${lastMigration.id}`;
      await database.close();
    }
  });
});
