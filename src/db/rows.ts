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

export {
  RESPONSE_CHOICES,
  SESSION_STATUSES
};

export type {
  ResponseChoice,
  SessionStatus
};
