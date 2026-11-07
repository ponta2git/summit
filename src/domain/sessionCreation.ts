import type { SessionStatus } from "../db/rows.ts";

/** The same admission boundary applies across dates and ISO weeks. */
export const ACTIVE_SESSION_STATUSES = [
  "ASKING", "POSTPONE_VOTING", "DECIDED", "CANCELLED"
] as const satisfies readonly SessionStatus[];

export const isActiveSession = (status: SessionStatus): boolean =>
  ACTIVE_SESSION_STATUSES.some(active => active === status);

export type CreationRejection =
  | "deadline_passed"
  | "outside_auto_window"
  | "auto_disabled"
  | "auto_started"
  | "date_exists"
  | "active_session";
