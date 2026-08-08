// source-of-truth: sessions repository の公開 input 型。

import type { EnqueueOutboxInput } from "./outbox.ts";

export interface CreateAskSessionInput {
  id: string;
  weekKey: string;
  postponeCount: number;
  candidateDateIso: string;
  channelId: string;
  deadlineAt: Date;
  /** Outbox rows to insert atomically with Session creation. */
  readonly outbox?: readonly EnqueueOutboxInput[];
}
