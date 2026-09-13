import type {
  ResponseChoice,
  ResponseRow,
  ResponsesPort
} from "../../src/db/ports.js";
import { makeResponse } from "./fixtures.js";
import { recordCall, type AnyCall } from "./ports.shared.js";

export interface FakeResponsesPort extends ResponsesPort {
  readonly calls: ReadonlyArray<AnyCall>;
  checkpoint(): () => void;
  listAllResponses(): ReadonlyArray<ResponseRow>;
  saveResponse(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly memberId: string;
    readonly choice: ResponseChoice;
    readonly answeredAt: Date;
    readonly sourceInteractionId?: string | null;
  }): Promise<ResponseRow>;
}

/** In-memory ResponsesPort with `(sessionId, memberId)` upsert semantics. */
export const createFakeResponsesPort = (
  seed: ReadonlyArray<ResponseRow> = []
): FakeResponsesPort => {
  const calls: AnyCall[] = [];
  const responses = seed.map((response) => makeResponse(response));
  const clone = (response: ResponseRow): ResponseRow => makeResponse(response);

  return {
    calls,
    checkpoint: () => {
      const snapshot = responses.map(clone);
      return () => { responses.splice(0, responses.length, ...snapshot); };
    },
    listAllResponses: () => responses.map(clone),
    listResponses: async (sessionId) => {
      recordCall(calls, "listResponses", { sessionId });
      return responses.filter((response) => response.sessionId === sessionId).map(clone);
    },
    saveResponse: async (input) => {
      recordCall(calls, "saveResponse", { input });
      const index = responses.findIndex(
        (response) =>
          response.sessionId === input.sessionId && response.memberId === input.memberId
      );
      if (index === -1) {
        const created = makeResponse(input);
        responses.push(created);
        return clone(created);
      }
      const current = responses[index] as ResponseRow;
      const next = makeResponse({
        ...current,
        choice: input.choice,
        answeredAt: input.answeredAt,
        sourceInteractionId:
          input.sourceInteractionId === undefined
            ? current.sourceInteractionId
            : input.sourceInteractionId
      });
      responses[index] = next;
      return clone(next);
    }
  };
};
