import { setImmediate } from "node:timers/promises";
import type postgres from "postgres";

export const waitForBlockedBy = async (client: postgres.Sql, pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const [row] = await client`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
    if (row?.["blocked"]) { return; }
    await setImmediate();
  }
  throw new Error("Contending transaction did not reach the held lock");
};

export const waitForLockWaiters = async (client: postgres.Sql, count: number): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const [row] = await client`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(row?.["count"]) >= count) { return; }
    await setImmediate();
  }
  throw new Error("Expected independent connections waiting on the held lock");
};
