import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { NotificationInputError } from "../../domain/notificationInput.ts";
import { assertNotificationNumericBudget } from "../../domain/notificationNumericBudget.ts";
import { RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES } from "../../notifications/config.ts";
import type { NotificationDb } from "./notifications.storage.ts";

/**
 * Keep the existing jsonb-numeric-sha256-v1 identity without a stored function.
 * PostgreSQL supplies its stable JSONB text/key ordering and lossless decimals;
 * the application strips numeric scale outside strings, then hashes UTF-8 bytes.
 */
export const hashJsonbText = (text: string): string => {
  const hash = createHash("sha256");
  let start = 0;
  let offset = 0;
  const digit = (code: number): boolean => code >= 48 && code <= 57;
  while (offset < text.length) {
    const character = text.charCodeAt(offset);
    if (character === 34) {
      offset += 1;
      // why: 長いメモを反復 alternation の正規表現で読むと backtracking 用 memory が膨らむ。
      while (offset < text.length) {
        const quoted = text.charCodeAt(offset++);
        if (quoted === 92) { offset += 1; }
        else if (quoted === 34) { break; }
      }
    } else if (character === 45 || digit(character)) {
      if (character === 45) { offset += 1; }
      while (digit(text.charCodeAt(offset))) { offset += 1; }
      if (text.charCodeAt(offset) !== 46) { continue; }
      const point = offset++;
      while (digit(text.charCodeAt(offset))) { offset += 1; }
      let end = offset;
      while (text.charCodeAt(end - 1) === 48) { end -= 1; }
      if (end === point + 1) { end = point; }
      if (end < offset) {
        hash.update(text.slice(start, end));
        start = offset;
      }
    } else { offset += 1; }
  }
  return hash.update(text.slice(start)).digest("hex");
};

export const normalizeNotificationJson = async (
  tx: Pick<NotificationDb, "execute">, text: string, maximumBytes = RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES
): Promise<{ readonly text: string; readonly hash: string; readonly bytes: number }> => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > RESULT_NOTIFICATION_LEGACY_MAX_JSONB_BYTES) {
    throw new Error("Invalid notification normalization budget");
  }
  assertNotificationNumericBudget(text, maximumBytes);
  // Reject numeric/escaping expansion in PostgreSQL before its text crosses the
  // driver boundary. The bound concerns decoded UTF-8 text, not TOAST storage.
  const [row] = await tx.execute<{ body: string | null; bytes: number }>(sql`
    WITH canonical AS MATERIALIZED (SELECT ${text}::jsonb::text AS body)
    SELECT CASE WHEN octet_length(body) <= ${maximumBytes} THEN body ELSE NULL END AS body,
      octet_length(body) AS bytes FROM canonical`);
  if (!row) { throw new Error("Notification JSON normalization failed"); }
  if (row.body === null || row.bytes > maximumBytes) { throw new NotificationInputError("payload_too_large"); }
  return { text: row.body, hash: hashJsonbText(row.body), bytes: row.bytes };
};
