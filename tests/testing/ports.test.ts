import { describe, expect, it } from "vitest";

import {
  createFakeResponsesPort,
  createFakeSessionsPort,
  createTestAppContext,
  makeSession
} from "./index.js";

describe("tests/testing helpers", () => {
  it("records sessions port calls and applies CAS transition", async () => {
    const sessions = createFakeSessionsPort([makeSession({ id: "s1", status: "ASKING" })]);

    const transitioned = await sessions.decideAsking({
      id: "s1",
      now: new Date("2026-04-24T12:30:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });

    expect({
      status: transitioned?.status,
      decidedStartAt: transitioned?.decidedStartAt,
      reminderAt: transitioned?.reminderAt
    }).toStrictEqual({
      status: "DECIDED",
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    expect(sessions.calls.map((call) => call.name)).toStrictEqual(["decideAsking"]);
  });

  it("refuses to transition on CAS loss", async () => {
    const sessions = createFakeSessionsPort([makeSession({ id: "s1", status: "DECIDED" })]);
    const result = await sessions.decideAsking({
      id: "s1",
      now: new Date("2026-04-24T12:30:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    expect(result).toBeUndefined();
  });

  it("upserts responses by (sessionId, memberId)", async () => {
    const responses = createFakeResponsesPort();
    await responses.upsertResponse({
      id: "r1",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2200",
      answeredAt: new Date("2026-04-24T12:00:00.000Z")
    });
    const updated = await responses.upsertResponse({
      id: "r2",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2330",
      answeredAt: new Date("2026-04-24T12:05:00.000Z")
    });

    expect({ id: updated.id, choice: updated.choice, answeredAt: updated.answeredAt })
      .toStrictEqual({
        id: "r1",
        choice: "T2330",
        answeredAt: new Date("2026-04-24T12:05:00.000Z")
      });
    expect(responses.listAllResponses()).toStrictEqual([updated]);
  });

  it("uses the AppContext clock for fake mutation timestamps", async () => {
    const now = new Date("2026-04-24T12:31:00.000Z");
    const ctx = createTestAppContext({
      now,
      seed: { sessions: [makeSession({ id: "s1", status: "ASKING" })] }
    });

    await ctx.ports.sessions.updateAskMessageId("s1", "message-1");

    const persisted = await ctx.ports.sessions.findSessionById("s1");
    expect({ askMessageId: persisted?.askMessageId, updatedAt: persisted?.updatedAt })
      .toStrictEqual({ askMessageId: "message-1", updatedAt: now });
  });

  it("returns scheduler session hints from active DB state", async () => {
    const sessions = createFakeSessionsPort([
      makeSession({
        id: "asking-late",
        status: "ASKING",
        deadlineAt: new Date("2026-04-24T12:30:00.000Z")
      }),
      makeSession({
        id: "asking-early",
        status: "ASKING",
        deadlineAt: new Date("2026-04-24T12:00:00.000Z")
      }),
      makeSession({
        id: "postpone",
        status: "POSTPONE_VOTING",
        deadlineAt: new Date("2026-04-25T00:00:00.000Z")
      }),
      makeSession({
        id: "decided",
        status: "DECIDED",
        reminderAt: new Date("2026-04-24T13:45:00.000Z"),
        reminderSentAt: null
      })
    ]);

    const hints = await sessions.getSchedulerSessionHints(new Date("2026-04-24T11:00:00.000Z"));

    expect(hints).toStrictEqual({
      nextAskingDeadlineAt: new Date("2026-04-24T12:00:00.000Z"),
      nextPostponeDeadlineAt: new Date("2026-04-25T00:00:00.000Z"),
      nextReminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
  });
});
