export const SYNC_DEADLINE_MS = 60_000;
export const SYNC_EXIT_GRACE_MS = 5_000;
export const SYNC_REQUEST_TIMEOUT_MS = 10_000;
export const SYNC_RESPONSE_MAX_BYTES = 1_048_576;

const completedStatuses = ["matched", "synced", "different"] as const;
const failureReasons = ["usage", "fly_environment", "invalid_settings", "request_failed", "response_too_large",
  "invalid_response", "verification_failed", "deadline_exceeded", "cancelled", "worker_failed"] as const;

/** A confirmed outcome has no failure details; an unconfirmed outcome always explains why. */
export type SyncReport =
  | { readonly status: typeof completedStatuses[number]; readonly reason?: never; readonly retryAfterMs?: never }
  | { readonly status: "failed" | "unknown"; readonly reason: typeof failureReasons[number]; readonly retryAfterMs?: never }
  | { readonly status: "failed" | "unknown"; readonly reason: "rate_limited"; readonly retryAfterMs?: number };

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
  const status = "status" in value ? value.status : undefined;
  const completed = completedStatuses.find(candidate => status === candidate);
  if (completed) {
    return "reason" in value || "retryAfterMs" in value ? undefined : { status: completed };
  }
  if ((status !== "failed" && status !== "unknown") || !("reason" in value)) { return undefined; }
  if (value.reason === "rate_limited") {
    if (!("retryAfterMs" in value)) { return { status, reason: "rate_limited" }; }
    const retryAfterMs = value.retryAfterMs;
    return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? { status, reason: "rate_limited", retryAfterMs } : undefined;
  }
  const reason = failureReasons.find(candidate => value.reason === candidate);
  return reason && !("retryAfterMs" in value) ? { status, reason } : undefined;
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
