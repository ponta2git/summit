import { describe, expect, it } from "vitest";

import type { ResponseRow, SessionRow } from "../../../src/db/rows.js";
import { evaluatePostponeVote } from "../../../src/features/postpone-voting/decide.js";
import { buildSessionRow } from "../../testing/sessionScenario.ts";

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({ id: "session-1", status: "POSTPONE_VOTING", ...overrides });

const responseRow = (overrides: Partial<ResponseRow> = {}): ResponseRow => ({
  id: "r1",
  sessionId: "session-1",
  memberId: "m1",
  choice: "POSTPONE_OK",
  answeredAt: new Date("2026-04-24T12:00:00.000Z"),
  sourceInteractionId: null,
  ...overrides
});

describe("evaluatePostponeVote", () => {
  it("returns all_ok when all expected members answered POSTPONE_OK", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const result = evaluatePostponeVote(
      session,
      [
        responseRow({ id: "r1", memberId: "m1" }),
        responseRow({ id: "r2", memberId: "m2" }),
        responseRow({ id: "r3", memberId: "m3" }),
        responseRow({ id: "r4", memberId: "m4" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T14:59:00.000Z") }
    );

    expect(result).toStrictEqual({ kind: "all_ok" });
  });

  it("returns cancelled/postpone_ng when at least one latest response is POSTPONE_NG", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const result = evaluatePostponeVote(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "POSTPONE_OK" }),
        responseRow({ id: "r2", memberId: "m2", choice: "POSTPONE_OK" }),
        responseRow({ id: "r3", memberId: "m3", choice: "POSTPONE_NG" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T14:59:00.000Z") }
    );

    expect(result).toStrictEqual({ kind: "cancelled", reason: "postpone_ng" });
  });

  it("returns cancelled/postpone_unanswered after deadline when answers are still incomplete", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const result = evaluatePostponeVote(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "POSTPONE_OK" }),
        responseRow({ id: "r2", memberId: "m2", choice: "POSTPONE_OK" }),
        responseRow({ id: "r3", memberId: "m3", choice: "T2200" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T15:00:00.000Z") }
    );

    expect(result).toStrictEqual({ kind: "cancelled", reason: "postpone_unanswered" });
  });

  it("returns pending before deadline when ng is absent and ok responses are still insufficient", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const result = evaluatePostponeVote(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "POSTPONE_OK" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T14:59:00.000Z") }
    );

    expect(result).toStrictEqual({ kind: "pending" });
  });

  it.each([
    {
      label: "NG→OK",
      earlierChoice: "POSTPONE_NG",
      latestChoice: "POSTPONE_OK",
      expected: { kind: "all_ok" }
    },
    {
      label: "OK→NG",
      earlierChoice: "POSTPONE_OK",
      latestChoice: "POSTPONE_NG",
      expected: { kind: "cancelled", reason: "postpone_ng" }
    }
  ] as const)("uses the latest answer per member when duplicate responses exist ($label)", ({
    earlierChoice,
    latestChoice,
    expected
  }) => {
    // race: 再押下で回答が更新された場合は、最新回答を採用して判定する。
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const result = evaluatePostponeVote(
      session,
      [
        responseRow({
          id: "r1",
          memberId: "m1",
          choice: earlierChoice,
          answeredAt: new Date("2026-04-24T12:00:00.000Z")
        }),
        responseRow({
          id: "r2",
          memberId: "m1",
          choice: latestChoice,
          answeredAt: new Date("2026-04-24T12:05:00.000Z")
        })
      ],
      { memberCountExpected: 1, now: new Date("2026-04-24T12:06:00.000Z") }
    );

    expect(result).toStrictEqual(expected);
  });

  it("ignores responses that belong to another session", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const result = evaluatePostponeVote(
      session,
      [responseRow({ sessionId: "foreign-session", memberId: "m1" })],
      { memberCountExpected: 1, now: new Date("2026-04-24T12:06:00.000Z") }
    );

    expect(result).toStrictEqual({ kind: "pending" });
  });

  it("uses answeredAt rather than input order to select the latest response", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const result = evaluatePostponeVote(
      session,
      [
        responseRow({
          id: "latest",
          choice: "POSTPONE_NG",
          answeredAt: new Date("2026-04-24T12:05:00.000Z")
        }),
        responseRow({
          id: "earlier",
          choice: "POSTPONE_OK",
          answeredAt: new Date("2026-04-24T12:00:00.000Z")
        })
      ],
      { memberCountExpected: 1, now: new Date("2026-04-24T12:06:00.000Z") }
    );

    expect(result).toStrictEqual({ kind: "cancelled", reason: "postpone_ng" });
  });
});
