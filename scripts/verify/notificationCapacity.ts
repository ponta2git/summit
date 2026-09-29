import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { databaseUrl, dropOwnedDatabase, newDatabasePrefix, requireLocalTestUrl } from "../../tests/integration/databaseLifecycle.ts";
import { CapacityError, capacityOptions, capacityTargetMet, type CapacityMetrics, type CapacityScenario } from "./notificationCapacity.contract.ts";
import { withCapacityContainer } from "./notificationCapacity.container.ts";
import { seedCapacitySources, seedLegacyCapacityNotification } from "./notificationCapacity.fixtures.ts";
import { exerciseLegacyCapacity, exerciseStandardCapacity } from "./notificationCapacity.scenarios.ts";

const root = new URL("../../", import.meta.url);
const connect = (url: string) => postgres(url, { max: 1, prepare: false, connect_timeout: 5,
  onnotice: () => undefined, connection: { statement_timeout: 30_000, lock_timeout: 5_000 } });

const verify = async (): Promise<void> => {
  const options = capacityOptions(process.argv.slice(2));
  const adminUrl = requireLocalTestUrl(process.env["TEST_DATABASE_URL"]).href;
  const configuration = await readFile(new URL("summit.config.example.yml", root), "utf8");
  const prefix = newDatabasePrefix();
  const database = `${prefix}_capacity`;
  const admin = connect(adminUrl);
  const cases: CapacityScenario[] = options.scenario === "all" ? ["standard", "legacy"] : [options.scenario];
  let cleanupFailed = false;
  let failure: unknown;
  try {
    await admin`CREATE DATABASE ${admin(database)}`;
    const ownedUrl = databaseUrl(adminUrl, database);
    const client = connect(ownedUrl);
    try {
      await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../momo-db/drizzle/", root)) });
      await seedCapacitySources(client);
      for (const scenario of cases) {
        console.log(JSON.stringify({ event: "notification_capacity.started", scenario,
          memoryMiB: options.memoryMiB, targetMiB: options.targetMiB }));
        const legacyBytes = scenario === "legacy" ? await seedLegacyCapacityNotification(client) : undefined;
        const { metrics, workload } = await withCapacityContainer<{ metrics: CapacityMetrics; workload: object }>({ ...options, scenario,
          databaseUrl: ownedUrl, configuration }, session => scenario === "standard"
          ? exerciseStandardCapacity(session, client) : exerciseLegacyCapacity(session, client));
        const targetMet = capacityTargetMet(metrics, options.targetMiB);
        console.log(JSON.stringify({ event: "notification_capacity.measured", scenario,
          memoryMiB: options.memoryMiB, targetMiB: options.targetMiB, targetMet,
          workload: { ...workload, ...(legacyBytes === undefined ? {} : { jsonbBytes: legacyBytes }) },
          received: metrics.received, sentParts: metrics.sentParts, delivered: metrics.deliveredNotifications,
          concurrency: { deliveries: metrics.maxPendingSends, receipts: metrics.maxPendingReceipts,
            claimBatch: metrics.maxClaimBatchCount, claimBatchBytes: metrics.maxClaimBatchBytes },
          rssMiB: { baseline: metrics.baselineRss / 1024 / 1024, peak: metrics.peakRss / 1024 / 1024,
            maximum: metrics.maxRss / 1024 / 1024, cgroupPeak: metrics.cgroupPeak / 1024 / 1024 } }));
        // The new workload has a hard 25% headroom gate. A legacy exception is
        // measured separately; it must remain compatible inside the VM limit.
        if (scenario === "standard" && !targetMet) { throw new CapacityError("memory_target"); }
      }
    } finally { await client.end({ timeout: 5 }); }
  } catch (error) { failure = error; }
  finally {
    // CREATE DATABASE may commit even if its response is lost. The exact owned
    // name remains safe to remove with IF EXISTS in every failure path.
    try { await dropOwnedDatabase(admin, database, prefix); }
    catch { cleanupFailed = true; }
    finally { await admin.end({ timeout: 5 }).catch(() => { cleanupFailed = true; }); }
  }
  if (cleanupFailed) { throw new CapacityError("setup_or_measurement"); }
  if (failure !== undefined) { throw failure; }
};

await verify().catch((error: unknown) => {
  const code = error instanceof CapacityError ? error.code : "setup_or_measurement";
  process.exitCode = { setup_or_measurement: 1, receipt_rejected: 2, oom: 3, timeout: 4, memory_target: 5 }[code];
  // No driver exceptions, child output, connection strings or payloads in logs.
  const detail = error instanceof CapacityError && error.detail ? ` (${error.detail})` : "";
  process.stderr.write(`Notification capacity verification failed: ${code}${detail}.\n`);
});
