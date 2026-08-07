import type {
  CompleteDecidedSessionAsHeldInput,
  CompleteDecidedSessionAsHeldResult,
  HeldEventParticipantRow,
  HeldEventRow,
  HeldEventsPort
} from "../../src/db/ports.js";
import { DEFAULT_CLOCK, recordCall, type AnyCall, type FakeClock } from "./ports.shared.js";
import type { FakeSessionsPort } from "./ports.sessions.js";

export interface FakeHeldEventsPort extends HeldEventsPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listHeldEvents(): ReadonlyArray<HeldEventRow>;
  listAllParticipants(): ReadonlyArray<HeldEventParticipantRow>;
}

export const createFakeHeldEventsPort = (
  sessionsPort: FakeSessionsPort,
  seed: {
    readonly heldEvents?: ReadonlyArray<HeldEventRow>;
    readonly participants?: ReadonlyArray<HeldEventParticipantRow>;
  } = {},
  clock: FakeClock = DEFAULT_CLOCK
): FakeHeldEventsPort => {
  const calls: AnyCall[] = [];
  const heldEvents = (seed.heldEvents ?? []).map((event) => ({ ...event }));
  const participants = (seed.participants ?? []).map((participant) => ({ ...participant }));
  let autoId = 0;
  const cloneHeld = (event: HeldEventRow): HeldEventRow => ({ ...event });
  const cloneParticipant = (
    participant: HeldEventParticipantRow
  ): HeldEventParticipantRow => ({ ...participant });

  return {
    calls,
    listHeldEvents: () => heldEvents.map(cloneHeld),
    listAllParticipants: () => participants.map(cloneParticipant),
    completeDecidedSessionAsHeld: async (
      input: CompleteDecidedSessionAsHeldInput
    ): Promise<CompleteDecidedSessionAsHeldResult | undefined> => {
      recordCall(calls, "completeDecidedSessionAsHeld", { input });
      const transitioned = await sessionsPort.completeSession({
        id: input.sessionId,
        now: input.reminderSentAt,
        reminderSentAt: input.reminderSentAt
      });
      if (!transitioned) {return undefined;}
      if (!transitioned.decidedStartAt) {
        throw new Error(
          `FakeHeldEventsPort: session ${transitioned.id} has no decidedStartAt despite DECIDED status`
        );
      }
      const existing = heldEvents.find((event) => event.sessionId === input.sessionId);
      const heldEvent: HeldEventRow = existing ?? {
        id: `fake-held-${++autoId}`,
        sessionId: input.sessionId,
        heldDateIso: transitioned.candidateDateIso,
        startAt: new Date(transitioned.decidedStartAt),
        createdAt: clock.now()
      };
      if (!existing) {heldEvents.push(heldEvent);}

      const insertedParticipants: HeldEventParticipantRow[] = [];
      const now = clock.now();
      for (const memberId of input.memberIds) {
        const duplicate = participants.find(
          (participant) =>
            participant.heldEventId === heldEvent.id && participant.memberId === memberId
        );
        if (duplicate) {continue;}
        const row: HeldEventParticipantRow = {
          heldEventId: heldEvent.id,
          memberId,
          createdAt: now
        };
        participants.push(row);
        insertedParticipants.push(row);
      }
      return {
        session: transitioned,
        heldEvent: cloneHeld(heldEvent),
        participants: insertedParticipants.map(cloneParticipant)
      };
    },
    findBySessionId: async (sessionId) => {
      recordCall(calls, "findBySessionId", { sessionId });
      const found = heldEvents.find((event) => event.sessionId === sessionId);
      return found ? cloneHeld(found) : undefined;
    },
    listParticipants: async (heldEventId) => {
      recordCall(calls, "listParticipants", { heldEventId });
      return participants
        .filter((participant) => participant.heldEventId === heldEventId)
        .map(cloneParticipant);
    }
  };
};
