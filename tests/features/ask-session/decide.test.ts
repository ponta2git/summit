import { describe, expect, it } from "vitest";

import type { ResponseRow, SessionRow } from "../../../src/db/rows.js";
import { evaluateDeadline } from "../../../src/features/ask-session/decide.js";
import { expectKind } from "../../helpers/assertions.js";
import { buildSessionRow } from "../../testing/sessionScenario.ts";

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({ id: "session-1", ...overrides });

const responseRow = (overrides: Partial<ResponseRow> = {}): ResponseRow => ({
  id: "r1",
  sessionId: "session-1",
  memberId: "m1",
  choice: "T2200",
  answeredAt: new Date(0),
  sourceInteractionId: null,
  ...overrides
});

describe("evaluateDeadline", () => {
  it("returns cancelled/all_absent when any ABSENT response exists", () => {
    const session = sessionRow();
    const result = evaluateDeadline(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "ABSENT" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T12:31:00.000Z") }
    );

    expect(result).toStrictEqual({ kind: "cancelled", reason: "all_absent" });
  });

  it("keeps all time choices pending before the deadline", () => {
    const session = sessionRow({
      candidateDateIso: "2026-04-24",
      deadlineAt: new Date("2026-04-24T12:30:00.000Z")
    });
    const result = evaluateDeadline(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
        responseRow({ id: "r3", memberId: "m3", choice: "T2300" }),
        responseRow({ id: "r4", memberId: "m4", choice: "T2330" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T12:29:00.000Z") }
    );

    expect(result).toStrictEqual({
      kind: "pending",
      reason: "not_all_answered_and_not_overdue"
    });
  });

  it("returns decided at the deadline when all members answered with time choices", () => {
    const session = sessionRow({
      candidateDateIso: "2026-04-24",
      deadlineAt: new Date("2026-04-24T12:30:00.000Z")
    });
    const result = evaluateDeadline(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
        responseRow({ id: "r3", memberId: "m3", choice: "T2300" }),
        responseRow({ id: "r4", memberId: "m4", choice: "T2330" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T12:30:00.000Z") }
    );

    expect(expectKind(result, "decided")).toStrictEqual({
      kind: "decided",
      chosenSlot: "T2330",
      startAt: new Date("2026-04-24T14:30:00.000Z")
    });
  });

  it("keeps deterministic latest slot when the same latest choice is tied", () => {
    const session = sessionRow({ candidateDateIso: "2026-04-24" });
    const result = evaluateDeadline(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "T2330" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
        responseRow({ id: "r3", memberId: "m3", choice: "T2330" }),
        responseRow({ id: "r4", memberId: "m4", choice: "T2200" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T12:31:00.000Z") }
    );

    expect(expectKind(result, "decided")).toStrictEqual({
      kind: "decided",
      chosenSlot: "T2330",
      startAt: new Date("2026-04-24T14:30:00.000Z")
    });
  });

  it("returns cancelled/deadline_unanswered at deadline when still partial", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T12:30:00.000Z") });
    const result = evaluateDeadline(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
        responseRow({ id: "r3", memberId: "m3", choice: "T2300" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T12:30:00.000Z") }
    );

    expect(result).toStrictEqual({ kind: "cancelled", reason: "deadline_unanswered" });
  });

  it("returns pending when partial answers exist but deadline has not passed", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T12:30:00.000Z") });
    const result = evaluateDeadline(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
        responseRow({ id: "r3", memberId: "m3", choice: "T2300" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T12:29:00.000Z") }
    );

    expect(result).toStrictEqual({
      kind: "pending",
      reason: "not_all_answered_and_not_overdue"
    });
  });
});
