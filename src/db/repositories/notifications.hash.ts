import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NotificationDb } from "./notifications.storage.ts";

/**
 * Keep the existing jsonb-numeric-sha256-v1 identity without a stored function.
 * PostgreSQL supplies its stable JSONB text/key ordering and lossless decimals;
 * the application strips numeric scale outside strings, then hashes UTF-8 bytes.
 */
const hashJsonbText = (text: string): string => createHash("sha256").update(
  text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?/g, token => {
    if (token.startsWith('"') || !token.includes(".")) { return token; }
    return token.replace(/0+$/, "").replace(/\.$/, "");
  })
).digest("hex");

export const normalizeNotificationJson = async (
  tx: Pick<NotificationDb, "execute">, text: string
): Promise<{ readonly text: string; readonly hash: string; readonly bytes: number }> => {
  const [row] = await tx.execute<{ body: string }>(sql`SELECT ${text}::jsonb::text AS body`);
  if (!row) { throw new Error("Notification JSON normalization failed"); }
  return { text: row.body, hash: hashJsonbText(row.body), bytes: Buffer.byteLength(row.body, "utf8") };
};
