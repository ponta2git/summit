import { describe, expect, it } from "vitest";

import type { ResponseRow, SessionRow } from "../../src/db/types.js";
import { evaluatePostponeVote } from "../../src/domain/postpone.js";
import { buildSessionRow } from "../scheduler/factories/session.js";

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({ id: "session-1", status: "POSTPONE_VOTING", ...overrides });

const responseRow = (overrides: Partial<ResponseRow> = {}): ResponseRow => ({
  id: "r1",
  sessionId: "session-1",
  memberId: "m1",
  choice: "POSTPONE_OK",
  answeredAt: new Date("2026-04-24T12:00:00.000Z"),
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

    expect(result).toEqual({ kind: "all_ok" });
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

    expect(result).toEqual({ kind: "cancelled", reason: "postpone_ng" });
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

    expect(result).toEqual({ kind: "cancelled", reason: "postpone_unanswered" });
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

    expect(result).toEqual({ kind: "pending" });
  });

  it("uses the latest answer per member when duplicate responses exist", () => {
    // race: 再押下で NG→OK に更新された場合は、最新回答を採用して判定する。
    const session = sessionRow({ deadlineAt: new Date("2026-04-24T15:00:00.000Z") });
    const result = evaluatePostponeVote(
      session,
      [
        responseRow({
          id: "r1",
          memberId: "m1",
          choice: "POSTPONE_NG",
          answeredAt: new Date("2026-04-24T12:00:00.000Z")
        }),
        responseRow({
          id: "r2",
          memberId: "m1",
          choice: "POSTPONE_OK",
          answeredAt: new Date("2026-04-24T12:05:00.000Z")
        })
      ],
      { memberCountExpected: 1, now: new Date("2026-04-24T12:06:00.000Z") }
    );

    expect(result).toEqual({ kind: "all_ok" });
  });
});
