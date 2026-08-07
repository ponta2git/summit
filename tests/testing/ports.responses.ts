import type {
  ResponseRow,
  ResponsesPort
} from "../../src/db/ports.js";
import { makeResponse } from "./fixtures.js";
import { recordCall, type AnyCall } from "./ports.shared.js";

export interface FakeResponsesPort extends ResponsesPort {
  readonly calls: ReadonlyArray<AnyCall>;
  listAllResponses(): ReadonlyArray<ResponseRow>;
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
    listAllResponses: () => responses.map(clone),
    listResponses: async (sessionId) => {
      recordCall(calls, "listResponses", { sessionId });
      return responses.filter((response) => response.sessionId === sessionId).map(clone);
    },
    upsertResponse: async (input) => {
      recordCall(calls, "upsertResponse", { input });
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
        answeredAt: input.answeredAt
      });
      responses[index] = next;
      return clone(next);
    }
  };
};
