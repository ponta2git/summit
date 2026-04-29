// source-of-truth: DB Row 型集約 (@see ADR-0014)。
import type { db as defaultDb } from "./client.js";
import {
  RESPONSE_CHOICES,
  SESSION_STATUSES,
  type heldEvents,
  type heldEventParticipants,
  type responses,
  type sessions,
  type ResponseChoice,
  type SessionStatus
} from "./schema.js";
import { parseTimestamp } from "../time/index.js";

export type DbLike = typeof defaultDb;

export type SessionRow = Omit<typeof sessions.$inferSelect, "status"> & {
  status: SessionStatus;
};

export type ResponseRow = Omit<typeof responses.$inferSelect, "choice"> & {
  choice: ResponseChoice;
};

export type HeldEventRow = typeof heldEvents.$inferSelect;
export type HeldEventParticipantRow = typeof heldEventParticipants.$inferSelect;

// why: listMembers は 3 列のみ select するため、port / fixtures が見る shape を
//   schema 全列ではなく実運用で surface する列に合わせる。
export type MemberRow = {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
};

/**
 * Elevate a DB text column value to a domain literal union T.
 *
 * @remarks
 * `readonly T[]` parameter is covariant, so `as const` arrays can be passed directly without casting.
 * `T` is inferred from `allowed`, so callers need no explicit type argument.
 * Throws on startup if the DB contains an unexpected value.
 */
export const assertEnum = <T extends string>(
  allowed: readonly T[],
  value: string,
  label: string
): T => {
  if ((allowed as readonly string[]).includes(value)) { return value as T; }
  throw new Error(`Invalid ${label}: "${value}". Expected one of: ${allowed.join(", ")}`);
};

/**
 * Normalize raw SQL timestamp aggregate values returned by postgres.js.
 *
 * @remarks
 * Drizzle maps table timestamp columns to Date, but raw aggregate expressions such as `min(...)`
 * can surface as strings. Keep conversion explicit at repository boundaries.
 */
export const parseDbTimestamp = (
  value: unknown,
  label: string
): Date | null => {
  if (value === null || value === undefined) { return null; }
  if (value instanceof Date) { return value; }
  if (typeof value === "string") {
    const parsed = parseTimestamp(value);
    if (parsed) { return parsed; }
  }
  throw new Error(`Invalid ${label}: expected timestamp-compatible value`);
};

export {
  RESPONSE_CHOICES,
  SESSION_STATUSES
};

export type {
  ResponseChoice,
  SessionStatus
};
