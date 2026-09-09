import { isIP } from "node:net";
import { buildNotificationLinks } from "../features/result-notifications/links.ts";

export const isPrivateNotificationBind = (host: string): boolean =>
  ["fly-local-6pn", "127.0.0.1", "::1", "localhost"].includes(host)
  || (isIP(host) === 6 && host.toLowerCase().startsWith("fdaa:"));

export const isNotificationWebOrigin = (origin: string): boolean => {
  try { buildNotificationLinks(origin); return true; } catch { return false; }
};

// Result notification I/O is bounded separately from attendance and calendar work.
export const RESULT_NOTIFICATION_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const RESULT_NOTIFICATION_MAX_JSONB_BYTES = 8 * 1024 * 1024;
export const RESULT_NOTIFICATION_MAX_RECEIPTS = 4;
export const RESULT_NOTIFICATION_MAX_CONNECTIONS = 32;
export const RESULT_NOTIFICATION_BODY_TIMEOUT_MS = 10_000;
export const RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS = 20_000;
export const RESULT_NOTIFICATION_LOCK_TIMEOUT_MS = 5_000;
export const RESULT_NOTIFICATION_SQL_TIMEOUT_MS = 10_000;
export const RESULT_NOTIFICATION_CONCURRENCY = 3;
export const RESULT_NOTIFICATION_SEND_TIMEOUT_MS = 45_000;
export const RESULT_NOTIFICATION_HEARTBEAT_MS = 10_000;
export const RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000] as const;
export const RESULT_NOTIFICATION_DEFAULT_PORT = 8081;
export const RESULT_NOTIFICATION_CLIENT_TIMEOUT_MS = RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS + 5_000;
