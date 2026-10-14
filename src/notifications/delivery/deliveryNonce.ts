import { createHash } from "node:crypto";

/** Stable across claims and retries; Discord only deduplicates within a short window. */
export const notificationNonce = (id: string, partNo: number): string =>
  createHash("sha256").update(JSON.stringify([id, partNo])).digest("base64url").slice(0, 25);
