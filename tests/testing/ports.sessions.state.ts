import type {
  EnqueueOutboxInput,
  SessionRow
} from "../../src/db/ports.js";
import { makeSession } from "./fixtures.js";
import type { AnyCall, FakeClock } from "./ports.shared.js";

export interface FakeSessionsState {
  readonly calls: AnyCall[];
  readonly byId: Map<string, SessionRow>;
  readonly clock: FakeClock;
  clone(session: SessionRow): SessionRow;
  enqueueOutbox(entries: readonly EnqueueOutboxInput[] | undefined): Promise<void>;
}

export const createFakeSessionsState = (
  seed: readonly SessionRow[],
  clock: FakeClock,
  outboxEnqueue: ((entry: EnqueueOutboxInput) => Promise<void>) | undefined
): FakeSessionsState => {
  const calls: AnyCall[] = [];
  const byId = new Map<string, SessionRow>(
    seed.map((session) => [session.id, makeSession(session)])
  );

  return {
    calls,
    byId,
    clock,
    clone: (session) => makeSession(session),
    enqueueOutbox: async (entries) => {
      if (!entries || entries.length === 0 || !outboxEnqueue) {return;}
      for (const entry of entries) {
        await outboxEnqueue(entry);
      }
    }
  };
};
