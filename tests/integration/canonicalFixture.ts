import { createHash } from "node:crypto";
import type { SessionRow, ResponseRow } from "../../src/db/rows.ts";

/** Stable fixture UUIDs keep saved wire aliases distinct from native identities. */
export const fixtureId = (table: string, alias: string): string => {
  const hash = createHash("sha256").update(`${table}:${alias}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
export const fixtureMember = (row: { id: string; userId: string; displayName: string }) =>
  ({ ...row, id: fixtureId("members", row.id), legacyId: row.id });
export const fixtureSession = (row: SessionRow) =>
  ({ ...row, id: fixtureId("sessions", row.id), legacyId: row.id });
export const fixtureResponse = (row: ResponseRow) =>
  ({ ...row, id: fixtureId("responses", row.id), legacyId: row.id,
    sessionId: fixtureId("sessions", row.sessionId), memberId: fixtureId("members", row.memberId) });
