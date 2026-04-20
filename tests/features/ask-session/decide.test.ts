import { describe, expect, it } from "vitest";

import type { ResponseRow, SessionRow } from "../../../src/db/rows.js";
import { evaluateDeadline } from "../../../src/features/ask-session/decide.js";
import { buildSessionRow } from "../../scheduler/factories/session.js";

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({ id: "session-1", ...overrides });

const responseRow = (overrides: Partial<ResponseRow> = {}): ResponseRow => ({
  id: "r1",
  sessionId: "session-1",
  memberId: "m1",
  choice: "T2200",
  answeredAt: new Date(0),
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

    expect(result).toEqual({ kind: "cancelled", reason: "all_absent" });
  });

  it("returns decided with latest slot when all members answered with time choices", () => {
    const session = sessionRow({ candidateDateIso: "2026-04-24" });
    const result = evaluateDeadline(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
        responseRow({ id: "r3", memberId: "m3", choice: "T2300" }),
        responseRow({ id: "r4", memberId: "m4", choice: "T2330" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T12:31:00.000Z") }
    );

    expect(result.kind).toBe("decided");
    if (result.kind !== "decided") {
      return;
    }
    expect(result.chosenSlot).toBe("T2330");
    expect(result.startAt.toISOString()).toBe("2026-04-24T14:30:00.000Z");
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

    expect(result.kind).toBe("decided");
    if (result.kind !== "decided") {
      return;
    }
    expect(result.chosenSlot).toBe("T2330");
  });

  it("returns cancelled/deadline_unanswered when still partial after deadline", () => {
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T12:30:00.000Z") });
    const result = evaluateDeadline(
      session,
      [
        responseRow({ id: "r1", memberId: "m1", choice: "T2200" }),
        responseRow({ id: "r2", memberId: "m2", choice: "T2230" }),
        responseRow({ id: "r3", memberId: "m3", choice: "T2300" })
      ],
      { memberCountExpected: 4, now: new Date("2026-04-24T12:31:00.000Z") }
    );

    expect(result).toEqual({ kind: "cancelled", reason: "deadline_unanswered" });
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

    expect(result).toEqual({
      kind: "pending",
      reason: "not_all_answered_and_not_overdue"
    });
  });
});
