import { describe, expect, it } from "vitest";

import {
  createTestAppContext,
  makeSession
} from "./index.js";

describe("tests/testing helpers", () => {
  it("refuses to transition on CAS loss", async () => {
    const initial = makeSession({ id: "s1", status: "DECIDED" });
    const sessions = createTestAppContext({ seed: { sessions: [initial] } }).ports.sessions;
    const result = await sessions.decideAsking({
      id: "s1",
      now: new Date("2026-04-24T12:30:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    expect(result).toBeUndefined();
    expect(await sessions.findSessionById("s1")).toStrictEqual(initial);
  });

  it("uses the AppContext clock for fake mutation timestamps", async () => {
    const now = new Date("2026-04-24T12:31:00.000Z");
    const initial = makeSession({ id: "s1", status: "ASKING" });
    const ctx = createTestAppContext({
      now,
      seed: { sessions: [initial] }
    });

    await ctx.ports.sessions.updateAskMessageId("s1", "message-1");

    expect(await ctx.ports.sessions.findSessionById("s1")).toStrictEqual(makeSession({
      ...initial,
      askMessageId: "message-1",
      updatedAt: now
    }));
  });

  it("returns only due POSTPONE_VOTING sessions", async () => {
    const now = new Date("2026-04-24T12:30:00.000Z");
    const sessions = createTestAppContext({ seed: { sessions: [
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
    ] } }).ports.sessions;

    expect((await sessions.findDuePostponeVotingSessions(now)).map((row) => row.id))
      .toStrictEqual(["due-pv"]);
  });

  it("returns startup-due DECIDED sessions even when a legacy reminder marker exists", async () => {
    const now = new Date("2026-04-24T12:30:00.000Z");
    const legacyMarked = makeSession({
      id: "legacy-marked",
      status: "DECIDED",
      reminderAt: new Date("2026-04-24T12:29:59.000Z"),
      reminderSentAt: new Date("2026-04-24T12:00:00.000Z")
    });
    const future = makeSession({
      id: "future-reminder",
      status: "DECIDED",
      reminderAt: new Date("2026-04-24T12:30:01.000Z")
    });
    const sessions = createTestAppContext({ seed: { sessions: [legacyMarked, future] } }).ports.sessions;

    expect((await sessions.findDueStartupRecoverySessions(now)).map((row) => row.id))
      .toStrictEqual(["legacy-marked"]);
  });

  it("keeps POSTPONED in the message recovery candidate set", async () => {
    const sessions = createTestAppContext({ seed: { sessions: [
      makeSession({ id: "postponed", status: "POSTPONED" }),
      makeSession({ id: "completed", status: "COMPLETED" })
    ] } }).ports.sessions;

    expect((await sessions.findMessageRecoveryCandidates()).map((row) => row.id))
      .toStrictEqual(["postponed"]);
  });

  it("keeps the current row unchanged when startPostponeVoting loses its CAS", async () => {
    const initial = makeSession({
      id: "s1",
      status: "ASKING",
      deadlineAt: new Date("2026-04-24T12:30:00.000Z")
    });
    const sessions = createTestAppContext({ seed: { sessions: [initial] } }).ports.sessions;

    expect(await sessions.startPostponeVoting({
      id: initial.id,
      now: new Date("2026-04-24T12:31:00.000Z"),
      postponeDeadlineAt: new Date("2026-04-24T15:00:00.000Z")
    })).toBeUndefined();
    expect(await sessions.findSessionById(initial.id)).toStrictEqual(initial);
  });

  it("returns scheduler session hints from active DB state", async () => {
    const sessions = createTestAppContext({ seed: { sessions: [
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
    ] } }).ports.sessions;

    const hints = await sessions.getSchedulerSessionHints(new Date("2026-04-24T11:00:00.000Z"));

    expect(hints).toStrictEqual({
      nextAskingDeadlineAt: new Date("2026-04-24T12:00:00.000Z"),
      nextPostponeDeadlineAt: new Date("2026-04-25T00:00:00.000Z"),
      nextReminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
  });
});
