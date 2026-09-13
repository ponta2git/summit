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
  checkpoint(): () => void;
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
  const heldEvents = (seed.heldEvents ?? []).map((event) => structuredClone(event));
  const participants = (seed.participants ?? []).map((participant) => structuredClone(participant));
  let autoId = 0;
  const cloneHeld = (event: HeldEventRow): HeldEventRow => structuredClone(event);
  const cloneParticipant = (
    participant: HeldEventParticipantRow
  ): HeldEventParticipantRow => structuredClone(participant);

  return {
    calls,
    checkpoint: () => {
      const events = heldEvents.map(cloneHeld);
      const people = participants.map(cloneParticipant);
      const id = autoId;
      return () => {
        heldEvents.splice(0, heldEvents.length, ...events);
        participants.splice(0, participants.length, ...people);
        autoId = id;
      };
    },
    listHeldEvents: () => heldEvents.map(cloneHeld),
    listAllParticipants: () => participants.map(cloneParticipant),
    completeDecidedSessionAsHeld: async (
      input: CompleteDecidedSessionAsHeldInput
    ): Promise<CompleteDecidedSessionAsHeldResult | undefined> => {
      recordCall(calls, "completeDecidedSessionAsHeld", { input });
      const current = await sessionsPort.findSessionById(input.sessionId);
      if (current?.status === "DECIDED" && !current.decidedStartAt) {
        throw new Error("DECIDED session requires decidedStartAt");
      }
      const transitioned = sessionsPort.completeDecidedForHeld(
        input.sessionId,
        input.reminderSentAt
      );
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
    }
  };
};
