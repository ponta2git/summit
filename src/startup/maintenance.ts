import { createHash, randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import postgres from "postgres";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) { throw new Error("MAINTENANCE_CONFIGURATION_REQUIRED"); }
  return value;
}

/** Reports the connection without importing any business runtime. */
export async function runMaintenance(env: NodeJS.ProcessEnv): Promise<void> {
  let reportPath: string | undefined;
  try {
    const database = required(env, "MOMO_CUTOVER_EXPECTED_DATABASE");
    const role = required(env, "MOMO_CUTOVER_EXPECTED_ROLE");
    const expectedLedger = required(env, "MOMO_CUTOVER_EXPECTED_LEDGER_SHA256");
    const imageDigest = required(env, "MOMO_CUTOVER_IMAGE_DIGEST");
    const machineId = required(env, "FLY_MACHINE_ID");
    reportPath = required(env, "MOMO_CUTOVER_REPORT_PATH");
    if (!reportPath.startsWith("/tmp/") || !/^[a-f0-9]{64}$/.test(expectedLedger) ||
        !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
      throw new Error("MAINTENANCE_CONFIGURATION_INVALID");
    }
    // why: 前回 boot の report を成功証拠として残さない。
    await unlink(reportPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") { throw error; }
    });
    const sql = postgres(required(env, "DATABASE_URL"), { max: 1, connect_timeout: 10,
      connection: { application_name: "summit-maintenance", statement_timeout: 15000 } });
    let ledger;
    let observedAt: string | undefined;
    try {
      ledger = await sql.begin("isolation level repeatable read read only", async tx => {
        const [identity] = await tx`SELECT current_database() AS database, current_user AS role,
          current_setting('transaction_read_only') AS read_only, session_user AS login_role,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS observed_at`;
        if (identity?.["database"] !== database || identity["role"] !== role || identity["read_only"] !== "on" || identity["login_role"] !== role ||
            typeof identity["observed_at"] !== "string") {
          throw new Error("MAINTENANCE_IDENTITY_MISMATCH");
        }
        observedAt = identity["observed_at"];
        const rows = await tx`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
        return rows.map(row => ({ hash: String(row["hash"]), created_at: String(row["created_at"]) }));
      });
    } finally { await sql.end({ timeout: 5 }); }
    const ledgerDigest = createHash("sha256").update(JSON.stringify(ledger)).digest("hex");
    if (ledgerDigest !== expectedLedger) { throw new Error("MAINTENANCE_LEDGER_MISMATCH"); }
    await writeFile(reportPath, JSON.stringify({ formatVersion: 1, consumer: "summit",
      mode: "maintenance", observedAt, database, role, ledger,
      ledgerDigest, machine: { id: machineId, bootId: randomUUID(), imageDigest }, readOnly: true }),
    { mode: 0o600, flag: "wx" });
    process.stdout.write("MAINTENANCE_READY\n");
    await new Promise<void>(resolve => {
      const timer = setInterval(() => {}, 60000);
      const stop = (): void => { clearInterval(timer); resolve(); };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    await unlink(reportPath);
  } catch {
    // redact: PostgreSQL errors may contain connection details; expose only a fixed code.
    process.stderr.write("MAINTENANCE_FAILED\n");
    process.exitCode = 1;
  }
}
