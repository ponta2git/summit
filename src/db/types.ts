// why: DB 層の型エクスポートを集約 (ADR-0014)
import type { db as defaultDb } from "./client.js";
import {
  RESPONSE_CHOICES,
  SESSION_STATUSES,
  type members,
  type responses,
  type sessions,
  type ResponseChoice,
  type SessionStatus
} from "./schema.js";

export type DbLike = typeof defaultDb;

export type SessionRow = Omit<typeof sessions.$inferSelect, "status"> & {
  status: SessionStatus;
};

export type ResponseRow = Omit<typeof responses.$inferSelect, "choice"> & {
  choice: ResponseChoice;
};

export type MemberRow = typeof members.$inferSelect;

export {
  RESPONSE_CHOICES,
  SESSION_STATUSES
};

export type {
  ResponseChoice,
  SessionStatus
};
