import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Delivery belongs to one Session or one weekly schedule; retained orphan identities are not deliverable. */
export type OutboxOwner =
  | { readonly sessionId: string; readonly weekKey?: never }
  | { readonly sessionId: null; readonly weekKey: string };

interface StoredOwner {
  readonly sessionId: string | null;
  readonly weekKey?: string | null;
}

export const parseOutboxOwner = (owner: StoredOwner): OutboxOwner | undefined => {
  if (typeof owner.sessionId === "string" && (owner.weekKey === null || owner.weekKey === undefined)) {
    return { sessionId: owner.sessionId };
  }
  if (owner.sessionId === null && typeof owner.weekKey === "string") {
    return { sessionId: null, weekKey: owner.weekKey };
  }
  return undefined;
};

export const assertOutboxOwner = (owner: StoredOwner): void => {
  if (!parseOutboxOwner(owner)) { throw new Error("Attendance notification must have exactly one owner"); }
};

interface OwnerColumns {
  readonly sessionId: SQLWrapper;
  readonly weekKey: SQLWrapper;
}

/** SQL NULL must never make unrelated weekly notifications or orphan identities share a chain. */
export const sameAttendanceOwner = (left: OwnerColumns, right: OwnerColumns): SQL =>
  sql`(${left.sessionId} = ${right.sessionId} OR ${left.weekKey} = ${right.weekKey})`;
