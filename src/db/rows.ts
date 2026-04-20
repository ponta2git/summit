// why: DB の Row 型と drizzle 派生型を集約 (ADR-0014)
import type { db as defaultDb } from "./client.js";
import {
  RESPONSE_CHOICES,
  SESSION_STATUSES,
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

// why: listMembers は 3 列のみ select しているため、port / fixtures が見る MemberRow は
//   schema 全列ではなく実運用で surface される shape に合わせる。
export type MemberRow = {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
};

export {
  RESPONSE_CHOICES,
  SESSION_STATUSES
};

export type {
  ResponseChoice,
  SessionStatus
};
