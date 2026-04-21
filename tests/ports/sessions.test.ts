import { describe, expect, it } from "vitest";

import { createFakeSessionsPort, makeSession } from "../testing/index.js";

describe("sessions port (fake) postpone voting semantics", () => {
  it("findDuePostponeVotingSessions: returns only POSTPONE_VOTING sessions whose deadline has passed", async () => {
    const now = new Date("2026-04-24T12:30:00.000Z");
    const sessions = createFakeSessionsPort([
      makeSession({
        id: "due-pv",
        status: "POSTPONE_VOTING",
        deadlineAt: new Date("2026-04-24T12:29:59.000Z")
      }),
      makeSession({
        id: "future-pv",
        status: "POSTPONE_VOTING",
        deadlineAt: new Date("2026-04-24T12:30:01.000Z")
      }),
      makeSession({
        id: "due-asking",
        status: "ASKING",
        deadlineAt: new Date("2026-04-24T12:00:00.000Z")
      }),
      makeSession({
        id: "due-postponed",
        status: "POSTPONED",
        deadlineAt: new Date("2026-04-24T12:00:00.000Z")
      }),
      makeSession({
        id: "due-completed",
        status: "COMPLETED",
        deadlineAt: new Date("2026-04-24T12:00:00.000Z")
      })
    ]);

    const due = await sessions.findDuePostponeVotingSessions(now);

    expect(due.map((session) => session.id)).toEqual(["due-pv"]);
  });

  it("startPostponeVoting: overwrites deadlineAt with postpone deadline", async () => {
    const sessions = createFakeSessionsPort([
      makeSession({
        id: "s1",
        status: "CANCELLED",
        deadlineAt: new Date("2026-04-24T12:30:00.000Z")
      })
    ]);
    const updatedDeadlineAt = new Date("2026-04-25T00:00:00.000Z");

    const transitioned = await sessions.startPostponeVoting({
      id: "s1",
      now: new Date("2026-04-24T12:30:01.000Z"),
      postponeDeadlineAt: updatedDeadlineAt
    });

    expect(transitioned?.status).toBe("POSTPONE_VOTING");
    expect(transitioned?.deadlineAt.toISOString()).toBe(updatedDeadlineAt.toISOString());
  });

  it("completePostponeVoting: keeps deadlineAt and completes on cancelled_full", async () => {
    const originalDeadlineAt = new Date("2026-04-24T12:30:00.000Z");
    const sessions = createFakeSessionsPort([
      makeSession({
        id: "s1",
        status: "POSTPONE_VOTING",
        deadlineAt: originalDeadlineAt
      })
    ]);

    const transitioned = await sessions.completePostponeVoting({
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      outcome: "cancelled_full",
      cancelReason: "postpone_ng"
    });

    expect(transitioned?.status).toBe("COMPLETED");
    expect(transitioned?.deadlineAt.toISOString()).toBe(originalDeadlineAt.toISOString());
  });

  // race: CAS 失敗時は undefined を返し、副作用なしで現在行を保持する。
  it("startPostponeVoting: returns undefined and does not change deadlineAt when from mismatches", async () => {
    const originalDeadlineAt = new Date("2026-04-24T12:30:00.000Z");
    const sessions = createFakeSessionsPort([
      makeSession({
        id: "s1",
        status: "ASKING",
        deadlineAt: originalDeadlineAt
      })
    ]);

    const result = await sessions.startPostponeVoting({
      id: "s1",
      now: new Date("2026-04-24T12:31:00.000Z"),
      postponeDeadlineAt: new Date("2026-04-25T00:00:00.000Z")
    });

    const persisted = await sessions.findSessionById("s1");
    expect(result).toBeUndefined();
    expect(persisted?.status).toBe("ASKING");
    expect(persisted?.deadlineAt.toISOString()).toBe(originalDeadlineAt.toISOString());
  });
});
