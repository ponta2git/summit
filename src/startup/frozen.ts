import { env } from "../env.ts";
import { logger } from "../logger.ts";
import { drainResources } from "../runtime/lifecycle.ts";
import { createMaintenanceDatabase } from "./maintenanceDatabase.ts";
import { createMaintenanceReadiness } from "./maintenanceReadiness.ts";

// envSchema rejects a missing token before selecting this entry.
if (!env.RESULT_NOTIFICATION_OPERATIONS_TOKEN) { throw new Error("Maintenance operations token is required"); }
const database = createMaintenanceDatabase(env.DATABASE_URL);
const readiness = createMaintenanceReadiness(env.RESULT_NOTIFICATION_OPERATIONS_TOKEN, database.probe);
let shutdown: Promise<void> | undefined;

const close = (): Promise<void> => {
  if (shutdown) { return shutdown; }
  // Read-only probes have no business work to commit. Pool close bounds any stalled read while drain retains ownership.
  shutdown = (async () => {
    try { readiness.stop(); }
    finally { await drainResources([() => readiness.drain(), () => database.close()]); }
  })();
  return shutdown;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shutdown) { return; }
    void close().then(() => { process.exit(0); }, () => {
      logger.error({ event: "maintenance.shutdown_failed" }, "Failed to close maintenance resources.");
      process.exit(1);
    });
  });
}

void readiness.start(env.RESULT_NOTIFICATION_BIND_HOST, env.RESULT_NOTIFICATION_PORT).then(() => {
  if (!shutdown) { logger.info({ event: "maintenance.frozen", mode: "frozen" }, "Business processing is frozen."); }
  return undefined;
}, async () => {
  logger.error({ event: "maintenance.start_failed" }, "Failed to start maintenance readiness.");
  try { await close(); } finally { process.exit(1); }
});
