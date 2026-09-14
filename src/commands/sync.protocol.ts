export const SYNC_DEADLINE_MS = 60_000;
export const SYNC_EXIT_GRACE_MS = 5_000;
export const SYNC_REQUEST_TIMEOUT_MS = 10_000;

const statuses = ["matched", "synced", "different", "failed", "unknown"] as const;
const reasons = ["usage", "fly_environment", "invalid_settings", "request_failed", "rate_limited",
  "invalid_response", "verification_failed", "deadline_exceeded", "cancelled", "worker_failed"] as const;

export interface SyncReport {
  readonly status: typeof statuses[number];
  readonly reason?: typeof reasons[number];
  readonly retryAfterMs?: number;
}

export interface SyncOptions {
  readonly production: boolean;
  readonly check: boolean;
}

export const parseSyncOptions = (args: readonly string[]): SyncOptions | undefined => {
  if (args.some(arg => arg !== "--production" && arg !== "--check") || new Set(args).size !== args.length) { return undefined; }
  return { production: args.includes("--production"), check: args.includes("--check") };
};

export const isFlyEnvironment = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  ["FLY_APP_NAME", "FLY_MACHINE_ID", "FLY_ALLOC_ID"].some(key => environment[key] !== undefined);

// secret: IPC も許可した分類・数値だけに射影し、任意の worker 出力をログへ流さない。
export const parseSyncReport = (value: unknown): SyncReport | undefined => {
  if (typeof value !== "object" || value === null) { return undefined; }
  const status = statuses.find(candidate => "status" in value && value.status === candidate);
  const reason = reasons.find(candidate => "reason" in value && value.reason === candidate);
  if (!status || ("reason" in value && !reason)) { return undefined; }
  const retryAfterMs = "retryAfterMs" in value ? value.retryAfterMs : undefined;
  if (retryAfterMs !== undefined && (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0)) { return undefined; }
  return { status, ...(reason === undefined ? {} : { reason }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
};

export const getSyncExitCode = (report: SyncReport): number => {
  if (report.reason === "deadline_exceeded") { return 124; }
  if (report.reason === "cancelled") { return 130; }
  switch (report.status) {
    case "matched": case "synced": return 0;
    case "different": return 2;
    case "unknown": return 3;
    case "failed": return 1;
  }
};
