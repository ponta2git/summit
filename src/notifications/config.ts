import { isIP } from "node:net";
import { parseNotificationWebOrigin } from "../domain/notification.ts";

export const isPrivateNotificationBind = (host: string): boolean =>
  ["fly-local-6pn", "127.0.0.1", "::1", "localhost"].includes(host)
  || (isIP(host) === 6 && host.toLowerCase().startsWith("fdaa:"));

export const isNotificationWebOrigin = (origin: string): boolean => {
  try { parseNotificationWebOrigin(origin); return true; } catch { return false; }
};

export const isNotificationToken = (token: string): boolean =>
  token.length >= 32 && token.length <= 512 && /^[A-Za-z0-9._~+/-]+=*$/.test(token);

// Result notification I/O is bounded separately from attendance and calendar work.
export const RESULT_NOTIFICATION_MAX_BODY_BYTES = 512 * 1024;
export const RESULT_NOTIFICATION_BODY_BUDGET_BYTES = 1024 * 1024;
export const RESULT_NOTIFICATION_MAX_JSONB_BYTES = 256 * 1024;
export const RESULT_NOTIFICATION_MAX_OCR_JSONB_BYTES = 16 * 1024;
// Existing identities and stored snapshots keep their original acceptance contract.
export const RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES = 8 * 1024 * 1024;
export const RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES = 512 * 1024;
export const RESULT_NOTIFICATION_MAX_MATCHES = 50;
export const RESULT_NOTIFICATION_MAX_SEASONS = 16;
export const RESULT_NOTIFICATION_MAX_PARTS = 128;
export const RESULT_NOTIFICATION_MAX_NAME_CODEPOINTS = 256;
export const RESULT_NOTIFICATION_MAX_DISPLAY_NAME_CODEPOINTS = 32;
export const RESULT_NOTIFICATION_MAX_NOTE_CODEPOINTS = 150;
export const RESULT_NOTIFICATION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const NOTIFICATION_MAINTENANCE_BATCH_SIZE = 256;
export const NOTIFICATION_RETENTION_MAX_BATCHES = 16;
export const RESULT_NOTIFICATION_MAX_RECEIPTS = 4;
export const RESULT_NOTIFICATION_MAX_CONNECTIONS = 32;
export const RESULT_NOTIFICATION_BODY_TIMEOUT_MS = 10_000;
export const RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS = 20_000;
export const RESULT_NOTIFICATION_LOCK_TIMEOUT_MS = 5_000;
export const RESULT_NOTIFICATION_SQL_TIMEOUT_MS = 10_000;
export const RESULT_NOTIFICATION_CONCURRENCY = 2;
export const RESULT_NOTIFICATION_SEND_TIMEOUT_MS = 45_000;
export const RESULT_NOTIFICATION_HEARTBEAT_MS = 10_000;
export const RESULT_NOTIFICATION_RECOVERY_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000] as const;
export const RESULT_NOTIFICATION_DEFAULT_PORT = 8081;
export const RESULT_NOTIFICATION_CLIENT_TIMEOUT_MS = RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS + 5_000;
